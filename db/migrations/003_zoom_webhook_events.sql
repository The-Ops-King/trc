-- Zoom "Webhook only" app (no Server-to-Server OAuth needed): Zoom pushes every participant joined / left event for meetings
-- and webinars on the account. Each event is kept once (Zoom retries); attendance per instance is rebuilt from them into
-- trc.zoom_instances / trc.zoom_attendees, the same tables a Server-to-Server pull would fill.
create table trc.zoom_events (
  id               bigserial primary key,
  event            text not null,             -- webinar.participant_joined | webinar.participant_left | meeting.participant_joined | meeting.participant_left
  zoom_type        text not null check (zoom_type in ('meeting', 'webinar')),
  zoom_id          text not null,             -- the meeting / webinar number
  instance_uuid    text not null,             -- this occurrence
  topic            text,
  instance_start   timestamptz,
  participant_key  text not null,             -- lower(email) when Zoom gives one, else "name:<lower(name)>"
  email            text,
  name             text,
  at               timestamptz not null,      -- join or leave time
  received_at      timestamptz not null default now(),
  unique (event, instance_uuid, participant_key, at)
);
create index zoom_events_instance_idx on trc.zoom_events (instance_uuid);
alter table trc.zoom_events enable row level security;
