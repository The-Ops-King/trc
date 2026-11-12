-- 2026-11-12 (Tyler: the dashboard works like PMU's, with Ads Spend, CPC, Outbound CTR, Registrations, Opt-in rate).
--   outbound_clicks: Meta's outbound clicks (the sheet gives Outbound CTR; clicks = CTR x impressions), for outbound CTR.
--   trc.kpi_targets: the targets, read from TRC's GHL Custom Values named "KPI …" (the same mechanism and names as PMU).
alter table trc.sheet_ad_daily add column outbound_clicks bigint;
alter table trc.meta_daily add column outbound_clicks bigint not null default 0;

create table trc.kpi_targets (
  name       text primary key,     -- the Custom Value's name, lower case ("kpi max cost per registrant")
  value      numeric not null,
  synced_at  timestamptz not null default now()
);
alter table trc.kpi_targets enable row level security;

-- Ad numbers by day, one source per day: Meta when the Meta connection has that day, otherwise the tracker sheet.
create or replace view trc.ad_daily as
select date, sum(spend_usd) as spend_usd, sum(landing_page_views) as landing_page_views, sum(link_clicks) as link_clicks, 'meta'::text as source,
       sum(impressions) as impressions, sum(outbound_clicks) as outbound_clicks
from trc.meta_daily group by date
union all
select s.date, s.spend_usd, 0::bigint, coalesce(s.link_clicks, 0), 'sheet', coalesce(s.impressions, 0), coalesce(s.outbound_clicks, 0)
from trc.sheet_ad_daily s
where not exists (select 1 from trc.meta_daily m where m.date = s.date);

-- Meta by ad (ready for the Meta token; empty until then). Registrations carry the ad's names in their UTMs (utm_campaign =
-- campaign, utm_content = ad set, utm_term = ad, Meta's {{campaign.name}} / {{adset.name}} / {{ad.name}}), so an ad's
-- registrants are matched to its spend by those names.
create table trc.meta_ad_daily (
  date            date not null,
  ad_id           text not null,
  campaign_id     text,
  campaign_name   text,
  adset_name      text,
  ad_name         text,
  spend_usd       numeric(12, 2) not null default 0,
  impressions     bigint not null default 0,
  link_clicks     bigint not null default 0,
  outbound_clicks bigint not null default 0,
  synced_at       timestamptz not null default now(),
  primary key (date, ad_id)
);
create table trc.meta_ads (
  ad_id         text primary key,
  status        text,           -- Meta's effective_status (ACTIVE, PAUSED, ...)
  thumbnail_url text,
  frequency_7d  numeric,        -- average times each person saw it in the last 7 days
  synced_at     timestamptz not null default now()
);
alter table trc.meta_ad_daily enable row level security;
alter table trc.meta_ads enable row level security;
