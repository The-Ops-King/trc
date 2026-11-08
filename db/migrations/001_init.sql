-- TRC dashboard schema.
-- Lives in its own schema (not `public`) so Supabase's auto-generated REST API
-- never exposes it. RLS is enabled with no policies as a second layer:
-- only the server, connecting as the database owner, can read or write.

create schema if not exists trc;
revoke all on schema trc from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema trc from anon, authenticated';
  end if;
end $$;

-- Webinar registrations: one row per GHL form submission.
-- A person who registers twice has two rows (one per session chosen).
create table trc.registrations (
  submission_id text primary key,
  form_id       text not null,
  contact_id    text,
  email         text,
  created_at    timestamptz not null,
  session_label text,
  session_at    timestamptz,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_content   text,
  utm_term      text,
  synced_at     timestamptz not null default now()
);
create index registrations_session_at_idx on trc.registrations (session_at);
create index registrations_email_idx on trc.registrations (lower(email));

-- GHL calendar appointments for the calendars mapped in src/lib/config.ts.
-- attended: GHL "showed"/"noshow" when someone marks it, otherwise filled from
-- the Zoom participant report once Zoom is connected. NULL = unknown.
create table trc.appointments (
  id                 text primary key,
  calendar_id        text not null,
  kind               text not null check (kind in ('onboarding', 'sales')),
  contact_id         text,
  email              text,
  start_at           timestamptz not null,
  appointment_status text,
  meeting_url        text,
  zoom_attended      boolean,
  synced_at          timestamptz not null default now()
);
create index appointments_start_at_idx on trc.appointments (start_at);
create index appointments_email_idx on trc.appointments (lower(email));

-- Whop payments (every attempt, paid or not).
create table trc.whop_payments (
  id                     text primary key,
  status                 text not null,
  substatus              text,
  email                  text,
  whop_user_id           text,
  product_id             text,
  product_title          text,
  plan_id                text,
  method                 text,
  billing_reason         text,
  created_at             timestamptz not null,
  paid_at                timestamptz,
  total_usd              numeric(12, 2) not null default 0,
  refunded_usd           numeric(12, 2) not null default 0,
  financing_installments int,
  excluded               boolean not null default false,
  synced_at              timestamptz not null default now()
);
create index whop_payments_email_idx on trc.whop_payments (lower(email));
create index whop_payments_paid_at_idx on trc.whop_payments (paid_at);

-- Meta Ads: one row per campaign per day.
create table trc.meta_daily (
  date              date not null,
  campaign_id       text not null,
  campaign_name     text,
  spend_usd         numeric(12, 2) not null default 0,
  impressions       bigint not null default 0,
  link_clicks       bigint not null default 0,
  landing_page_views bigint not null default 0,
  synced_at         timestamptz not null default now(),
  primary key (date, campaign_id)
);

-- Zoom meeting/webinar instances that matched a webinar session or an onboarding call.
create table trc.zoom_instances (
  uuid          text primary key,
  zoom_id       text not null,
  zoom_type     text not null check (zoom_type in ('meeting', 'webinar')),
  kind          text not null check (kind in ('webinar', 'onboarding')),
  topic         text,
  start_at      timestamptz not null,
  session_at    timestamptz,          -- set for webinar instances
  appointment_id text,                -- set for onboarding instances
  participants_fetched boolean not null default false,
  synced_at     timestamptz not null default now()
);
create index zoom_instances_session_idx on trc.zoom_instances (session_at);

-- One row per person per instance (join/leave segments already summed).
create table trc.zoom_attendees (
  instance_uuid text not null references trc.zoom_instances (uuid) on delete cascade,
  person_key    text not null,         -- lower(email) when known, else "name:<lower(name)>"
  email         text,
  name          text,
  first_join_at timestamptz,
  last_leave_at timestamptz,
  minutes       numeric(8, 2) not null default 0,
  primary key (instance_uuid, person_key)
);
create index zoom_attendees_email_idx on trc.zoom_attendees (lower(email));

-- Sync bookkeeping.
create table trc.sync_state (
  source     text primary key,
  cursor     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table trc.sync_runs (
  id          bigserial primary key,
  trigger     text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  detail      jsonb
);

alter table trc.registrations enable row level security;
alter table trc.appointments  enable row level security;
alter table trc.whop_payments enable row level security;
alter table trc.sync_state    enable row level security;
alter table trc.sync_runs     enable row level security;
alter table trc.meta_daily    enable row level security;
alter table trc.zoom_instances enable row level security;
alter table trc.zoom_attendees enable row level security;

-- ---------------------------------------------------------------------------
-- Business rules (single source of truth for classification).
-- ---------------------------------------------------------------------------

-- Product groups, by Whop product name:
--   mastermind: anything with "4M" or "Mastermind" (bundles with Ignite included)
--   ignite:     any other product with "Ignite"
--   other:      everything else (sub-$3k offers such as Wake Up to Wealth)
create function trc.product_group(title text) returns text
language sql immutable as $$
  select case
    when title ~* '(\m4m\M|mastermind)' then 'mastermind'
    when title ~* 'ignite' then 'ignite'
    else 'other'
  end
$$;

-- Third-party financing providers (buy-now-pay-later / consumer finance).
create function trc.is_third_party_financing(method text) returns boolean
language sql immutable as $$
  select coalesce(method, '') = any (array['sezzle', 'klarna', 'afterpay_clearpay', 'splitit', 'claritypay', 'affirm'])
$$;

create view trc.paid_payments as
select
  p.*,
  lower(p.email) as email_key,
  p.total_usd - p.refunded_usd as net_usd,
  trc.product_group(p.product_title) as product_group
from trc.whop_payments p
where p.status = 'paid'
  and not p.excluded
  and p.total_usd - p.refunded_usd > 0;

-- A purchase = one buyer x one product group.
-- Payment type:
--   third_party_financing: any part paid through a financing provider
--   pif:                   every payment within 7 days of the first, no Whop subscription billing
--   payment_plan:          everything else (Whop splits it in-house)
create view trc.purchases as
select
  email_key,
  product_group,
  min(paid_at) as first_paid_at,
  max(paid_at) as last_paid_at,
  count(*) as payment_count,
  sum(net_usd) as cash_usd,
  case
    when bool_or(trc.is_third_party_financing(method)) then 'third_party_financing'
    when max(paid_at) - min(paid_at) <= interval '7 days'
         and not bool_or(coalesce(billing_reason, '') like 'subscription%') then 'pif'
    else 'payment_plan'
  end as payment_type
from trc.paid_payments
group by email_key, product_group;

-- Each purchase is attributed to the most recent webinar session the buyer
-- registered for that started before their first payment.
create view trc.purchase_attribution as
select pu.*, r.session_at
from trc.purchases pu
left join lateral (
  select session_at from trc.registrations r
  where lower(r.email) = pu.email_key and r.session_at is not null and r.session_at <= pu.first_paid_at
  order by r.session_at desc limit 1
) r on true;

-- Onboarding appointments attributed the same way (latest session before the call).
-- attended: a manual GHL mark wins; otherwise the Zoom report; NULL = unknown.
create view trc.onboarding_attribution as
select
  a.*,
  lower(a.email) as email_key,
  case
    when a.appointment_status = 'showed' then true
    when a.appointment_status = 'noshow' then false
    else a.zoom_attended
  end as attended,
  r.session_at
from trc.appointments a
left join lateral (
  select session_at from trc.registrations r
  where lower(r.email) = lower(a.email) and r.session_at is not null and r.session_at <= a.start_at
  order by r.session_at desc limit 1
) r on true
where a.kind = 'onboarding';
