-- 2026-11-16 (Tyler): the call numbers can be shown for everyone, Nick only or Tiffany only ("these are the ones she took, these
-- are the ones Nick took, these are both"), so Nick's numbers are clear. A booking's host is the GHL user the calendar assigned
-- (assignedUserId); bookings made before the round robin assigned anyone (through Oct 29) have none and count under "All" only.
alter table trc.appointments add column host_user_id text;

-- onboarding_attribution lists the appointment's columns, so it is made again to carry the new one
drop view trc.onboarding_attribution;
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

-- the calendars are read again once so every existing booking gets its host
delete from trc.sync_state where source = 'ghl_appointments';
