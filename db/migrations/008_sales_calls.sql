-- 2026-11-20 (Tyler): the sales tracker tab. One row per GHL "TRC Sales Call" record (custom_objects.trc_sales_call), which the
-- engine (Backend-in-a-box) writes: one record per call slot, keyed by external_id = the GHL appointment id, plus "@<slot ISO>"
-- when the appointment was moved and the engine opened a record for the new slot. The appointment says when a call is booked;
-- the Sales Call says what happened on it (GHL appointments are never marked showed or no-show for TRC). Read only, never written.
create table trc.sales_calls (
  id              text primary key,          -- the GHL record id
  external_id     text not null,
  appointment_id  text not null,             -- external_id up to the "@"
  contact_id      text,
  slot_at         timestamptz,               -- scheduled_at: the slot this record is for
  closer          text,                      -- the closer's option key (nick, tiffany)
  outcome         text,                      -- scheduled, showed, no_show, cancelled, rescheduled
  disposition     text,                      -- closed_won, deposit, close_pending, follow_up, lost, dq, no_offer, financing_denied
  objection       text,                      -- price, partner, timing, fear, competitor, think_about_it
  call_type       text,                      -- closing, follow_up
  package         text,                      -- read when the object has the field; null until then
  pitched         text,                      -- yes, no
  cash_collected  numeric(12, 2),
  contract_value  numeric(12, 2),
  payment_terms   text,
  recording_url   text,
  duration_min    numeric(8, 2),
  next_step_date  date,
  created_at      timestamptz,
  updated_at      timestamptz,
  synced_at       timestamptz not null default now()
);
create index sales_calls_slot_idx on trc.sales_calls (slot_at);
create index sales_calls_contact_idx on trc.sales_calls (contact_id);
alter table trc.sales_calls enable row level security;
