-- 2026-11-13 (Tyler): track partials. A partial is a person who gave a name plus an email or phone (a webinar registration) and
-- has never booked a call on any of TRC's GHL calendars (with Tiffany or Nick; cancelled or no-show still counts as booked).
-- People, not contact records: contacts with the same name and email, or the same name and phone, are one person.

-- the registration form's own name and phone (the form always asks for both), for matching people across contacts
alter table trc.registrations add column full_name text, add column phone text;

-- every GHL calendar is read now ("booked a call at all"); calendars the dashboard doesn't report on are kind 'other'
alter table trc.appointments drop constraint appointments_kind_check;
alter table trc.appointments add constraint appointments_kind_check check (kind in ('onboarding', 'sales', 'other'));

-- the GHL contact behind each appointment (name, email, phone), read once per contact, for matching bookers to registrants
create table trc.ghl_contacts (
  contact_id text primary key,
  full_name  text,
  email      text,
  phone      text,
  fetched_at timestamptz not null default now()
);
alter table trc.ghl_contacts enable row level security;

-- the team (GHL users of TRC's location): never counted as prospects, refreshed by every sync
create table trc.team (
  email      text primary key,
  name       text,
  synced_at  timestamptz not null default now()
);
alter table trc.team enable row level security;

-- the registrations sync re-reads everything once so existing rows get their name and phone
delete from trc.sync_state where source in ('ghl_registrations', 'ghl_appointments');

-- Zoom attendance is rebuilt once under the new rule (the host and the team are not attendees)
update trc.zoom_instances set rebuilt_through = 0;
delete from trc.zoom_unmatched;
