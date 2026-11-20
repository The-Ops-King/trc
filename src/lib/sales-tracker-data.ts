// What the sales tracker tab reads from the database. The rules are in sales-tracker.ts.
import "server-only";
import { db, serial } from "./db";
import { CALL_HOSTS, SALES_TRACKER } from "./config";
import { isTestOrTeam } from "./people";
import { classify, bookingsWithoutRecord, trackerPayments, packageFromProducts, type Appt, type Basis, type Person, type SalesCallRow, type ShowSource, type WhopPayment } from "./sales-tracker";

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Through serial (db.ts), like the webinar page: it shares the one connection with every other request on this server. */
export function loadSalesTracker(o: { now: Date; basis: Basis; shows: ShowSource; dayStart: (d: Date) => Date }) {
  return serial(() => loadSalesTrackerNow(o));
}

async function loadSalesTrackerNow(o: { now: Date; basis: Basis; shows: ShowSource; dayStart: (d: Date) => Date }) {
  const sql = db();
  const calendarIds = SALES_TRACKER.calendars.map((k) => k.id);
  // One query at a time on the one connection (db.ts): queries sent together on it make the pooler stop answering (2026-11-20:
  // this page sent six at once and hung the whole dashboard).
  const rawRows = await sql<Array<Omit<SalesCallRow, "cash_collected" | "contract_value" | "duration_min" | "next_step_date"> & { cash_collected: string | null; contract_value: string | null; duration_min: string | null; next_step_date: string | null }>>`
      select id, external_id, appointment_id, contact_id, slot_at, closer, outcome, disposition, objection, call_type, package, pitched,
             cash_collected, contract_value, payment_terms, recording_url, duration_min, to_char(next_step_date, 'YYYY-MM-DD') as next_step_date,
             created_at, updated_at
      from trc.sales_calls where closer in ${sql(SALES_TRACKER.closers as string[])}`;
  const apptRows = await sql<Appt[]>`
      select a.id, a.contact_id, a.calendar_id, a.start_at, a.host_user_id, a.zoom_attended, a.appointment_status from trc.appointments a
      where a.calendar_id in ${sql(calendarIds)} or a.id in (select appointment_id from trc.sales_calls)`;
  const contactRows = await sql<Array<{ contact_id: string; full_name: string | null; email: string | null }>>`
      select g.contact_id, g.full_name, g.email from trc.ghl_contacts g where g.contact_id in (select contact_id from trc.sales_calls where contact_id is not null)
         or g.contact_id in (select contact_id from trc.appointments where calendar_id in ${sql(calendarIds)} and contact_id is not null)`;
  const team = await sql<{ email: string }[]>`select email from trc.team`;
  const sync = await sql<Array<{ finished_at: Date | null; detail: Record<string, { ok: boolean; error?: string; detail?: Record<string, unknown> }> | null }>>`
      select finished_at, detail from trc.sync_runs where finished_at is not null order by id desc limit 1`;
  const lastOk = await sql<{ at: Date | null }[]>`select max(finished_at) as at from trc.sync_runs where ok`;
  const rows: SalesCallRow[] = rawRows.map((r) => ({ ...r, cash_collected: num(r.cash_collected), contract_value: num(r.contract_value), duration_min: num(r.duration_min) }));
  const people = new Map<string, Person>(contactRows.map((c) => [c.contact_id, { contact_id: c.contact_id, name: c.full_name, email: c.email }]));
  const teamSet = new Set(team.map((t) => t.email));
  // Test and team bookings are never prospects, the same rule as the rest of the dashboard.
  const prospects = rows.filter((r) => { const p = r.contact_id ? people.get(r.contact_id) : null; return !p || !isTestOrTeam(p.email, p.name, teamSet); });
  const appts = new Map(apptRows.map((a) => [a.id, a]));
  const calls = classify(prospects, appts, people, { now: o.now, closers: SALES_TRACKER.closers, calendars: calendarIds, basis: o.basis, shows: o.shows });

  const emails = [...new Set(calls.flatMap((c) => (c.person?.email ? [c.person.email.toLowerCase()] : [])))];
  const payRows = emails.length ? await sql<Array<{ id: string; email: string; paid_at: Date; net_usd: string; product_title: string | null; method: string | null }>>`
    select id, email_key as email, paid_at, net_usd, product_title, method from trc.paid_payments where email_key in ${sql(emails)}` : [];
  const payments: WhopPayment[] = payRows.map((p) => ({ ...p, net_usd: Number(p.net_usd) }));
  const pays = trackerPayments(calls, payments, o.dayStart);
  // a close, deposit or pending with no package on its Sales Call takes the one its person's Whop products say, marked as from Whop
  const products = new Map<string, string[]>();
  for (const p of pays) if (p.product_title) products.set(p.contact_id, [...(products.get(p.contact_id) ?? []), p.product_title]);
  for (const c of calls) {
    if (c.package) { c.packageFrom = "sales_call"; continue; }
    if (!["closed_won", "deposit", "close_pending"].includes(c.disposition ?? "") || !c.contact_id) continue;
    const fromWhop = packageFromProducts(products.get(c.contact_id) ?? [], SALES_TRACKER.packageFromProduct);
    if (fromWhop) { c.package = fromWhop; c.packageFrom = "whop"; }
  }

  const hostIds = CALL_HOSTS.filter((h) => SALES_TRACKER.closers.includes(h.key)).map((h) => h.ghlUserId);
  const firstSlot = calls.reduce<Date | null>((m, c) => (!m || c.slot_at! < m ? c.slot_at : m), null);
  const missing = firstSlot ? bookingsWithoutRecord(apptRows, rows, { now: o.now, calendars: calendarIds, hostIds, since: firstSlot }) : [];
  const step = sync[0]?.detail?.ghl_sales_calls ?? null;
  return { calls, pays, missing, people, step, lastOk: lastOk[0]?.at ?? null, recordCount: rows.length };
}
