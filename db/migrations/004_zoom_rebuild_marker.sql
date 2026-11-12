-- Zoom attendance is rebuilt outside the webhook request (2026-11-12: rebuilding inside each request timed out when Zoom sent a
-- burst of joins). An instance is "dirty" when it has events newer than the last one its rebuild read; the dashboard load, the
-- daily sync and the webhook (after it has answered Zoom) rebuild dirty instances. rebuilt_through = the highest zoom_events.id
-- the last rebuild read; instances Zoom sent events for that matched nothing are remembered in zoom_unmatched the same way, so
-- they are not re-read on every pass.
alter table trc.zoom_instances add column rebuilt_through bigint not null default 0;

create table trc.zoom_unmatched (
  instance_uuid   text primary key,
  rebuilt_through bigint not null default 0,
  checked_at      timestamptz not null default now()
);
alter table trc.zoom_unmatched enable row level security;

-- Instances with events no rebuild has read yet.
create view trc.zoom_dirty as
select e.instance_uuid, max(e.id) as last_event_id
from trc.zoom_events e
left join trc.zoom_instances i on i.uuid = e.instance_uuid
left join trc.zoom_unmatched u on u.instance_uuid = e.instance_uuid
group by e.instance_uuid
having max(e.id) > greatest(coalesce(max(i.rebuilt_through), 0), coalesce(max(u.rebuilt_through), 0));
