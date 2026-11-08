import "server-only";
import { db } from "./db";

/** Minutes after webinar start that count as "stayed until the pitch". */
export const PITCH_MINUTE = 45;

export type SessionRow = {
  session_at: Date;
  label: string | null;
  registrants: number;
  ad_spend: number | null;          // allocated (see note in sessionMetrics)
  landing_page_views: number | null;
  attendees: number | null;         // null until Zoom data exists for the session
  stayed_to_pitch: number | null;
  buyers: number;
  cash: number;
  attendee_buyers: number | null;
  onb_booked: number;
  onb_past: number;                 // booked calls whose time has passed
  onb_attended: number;
  onb_unknown: number;
  ht_buyers: number;
  ht_cash: number;
  ht_after_onb_booked: number;
  ht_after_onb_attended: number;
  ht_purchases: number;
  ht_pif: number;
  ht_financing: number;
  ht_plan: number;
};

/**
 * One row per webinar session in [from, to].
 *
 * Attribution: a purchase or onboarding call belongs to the most recent session
 * the person registered for before it happened (see the views in 001_init.sql).
 *
 * Ad spend per session: each day's Meta spend is split across sessions in
 * proportion to that day's registrations for each session. Period totals in
 * periodTotals() use the unallocated numbers.
 */
export async function sessionMetrics(from: Date, to: Date): Promise<SessionRow[]> {
  const sql = db();
  return sql<SessionRow[]>`
    with s as (
      select session_at, min(session_label) as label, count(distinct lower(email))::int as registrants
      from trc.registrations
      where session_at >= ${from} and session_at < ${to} and email is not null
      group by session_at
    ),
    reg_day as (
      select (created_at at time zone 'America/Los_Angeles')::date as d, session_at, count(*)::numeric as n
      from trc.registrations where session_at is not null group by 1, 2
    ),
    day_tot as (select d, sum(n) as tot from reg_day group by d),
    meta_day as (
      select date as d, sum(spend_usd) as spend, sum(landing_page_views)::numeric as lpv from trc.meta_daily group by date
    ),
    alloc as (
      select rd.session_at, sum(md.spend * rd.n / dt.tot) as spend, sum(md.lpv * rd.n / dt.tot) as lpv
      from reg_day rd join day_tot dt using (d) join meta_day md using (d)
      group by rd.session_at
    ),
    web as (
      select zi.session_at,
             count(distinct za.person_key)::int as attendees,
             count(distinct za.person_key) filter (
               where za.last_leave_at >= zi.start_at + make_interval(mins => ${PITCH_MINUTE})
             )::int as stayed
      from trc.zoom_instances zi
      left join trc.zoom_attendees za on za.instance_uuid = zi.uuid
      where zi.kind = 'webinar' and zi.participants_fetched
      group by zi.session_at
    ),
    pa as (select * from trc.purchase_attribution where session_at is not null),
    buy as (
      select session_at, count(distinct email_key)::int as buyers, sum(cash_usd) as cash from pa group by session_at
    ),
    att_buy as (
      select pa.session_at, count(distinct pa.email_key)::int as n
      from pa
      join trc.zoom_instances zi on zi.session_at = pa.session_at and zi.kind = 'webinar'
      join trc.zoom_attendees za on za.instance_uuid = zi.uuid and za.email = pa.email_key
      group by pa.session_at
    ),
    onb as (
      select session_at,
             count(distinct email_key) filter (where coalesce(appointment_status, '') <> 'cancelled')::int as booked,
             count(distinct email_key) filter (
               where start_at < now() and coalesce(appointment_status, '') <> 'cancelled'
             )::int as past,
             count(distinct email_key) filter (where attended)::int as attended,
             count(distinct email_key) filter (
               where attended is null and start_at < now() and coalesce(appointment_status, '') <> 'cancelled'
             )::int as unknown
      from trc.onboarding_attribution where session_at is not null
      group by session_at
    ),
    ht as (
      select pa.session_at,
             count(distinct pa.email_key)::int as buyers,
             sum(pa.cash_usd) as cash,
             count(*)::int as purchases,
             count(*) filter (where pa.payment_type = 'pif')::int as pif,
             count(*) filter (where pa.payment_type = 'third_party_financing')::int as financing,
             count(*) filter (where pa.payment_type = 'payment_plan')::int as plan,
             count(distinct pa.email_key) filter (where exists (
               select 1 from trc.onboarding_attribution o
               where o.email_key = pa.email_key and o.start_at <= pa.first_paid_at
                 and coalesce(o.appointment_status, '') <> 'cancelled'
             ))::int as after_onb_booked,
             count(distinct pa.email_key) filter (where exists (
               select 1 from trc.onboarding_attribution o
               where o.email_key = pa.email_key and o.start_at <= pa.first_paid_at and o.attended
             ))::int as after_onb_attended
      from pa where pa.product_group in ('ignite', 'mastermind')
      group by pa.session_at
    )
    select
      s.session_at, s.label, s.registrants,
      alloc.spend as ad_spend, alloc.lpv as landing_page_views,
      web.attendees, web.stayed as stayed_to_pitch,
      coalesce(buy.buyers, 0) as buyers, coalesce(buy.cash, 0) as cash,
      case when web.session_at is null then null else coalesce(att_buy.n, 0) end as attendee_buyers,
      coalesce(onb.booked, 0) as onb_booked, coalesce(onb.past, 0) as onb_past, coalesce(onb.attended, 0) as onb_attended, coalesce(onb.unknown, 0) as onb_unknown,
      coalesce(ht.buyers, 0) as ht_buyers, coalesce(ht.cash, 0) as ht_cash,
      coalesce(ht.after_onb_booked, 0) as ht_after_onb_booked, coalesce(ht.after_onb_attended, 0) as ht_after_onb_attended,
      coalesce(ht.purchases, 0) as ht_purchases, coalesce(ht.pif, 0) as ht_pif,
      coalesce(ht.financing, 0) as ht_financing, coalesce(ht.plan, 0) as ht_plan
    from s
    left join alloc using (session_at)
    left join web using (session_at)
    left join buy using (session_at)
    left join att_buy using (session_at)
    left join onb using (session_at)
    left join ht using (session_at)
    order by s.session_at desc`;
}

export type PeriodTotals = {
  ad_spend: number;
  landing_page_views: number;
  registrants: number;
  cash_all: number;
  cash_webinar: number;
  by_group: Array<{ product_group: string; payment_type: string; purchases: number; cash: number }>;
  failed: { attempts: number; people: number; attempted_usd: number; recovered_people: number };
};

/** Totals for [from, to] by event date (spend date, registration date, payment date). */
export async function periodTotals(from: Date, to: Date): Promise<PeriodTotals> {
  const sql = db();
  const [base] = await sql<Array<Omit<PeriodTotals, "by_group" | "failed">>>`
    select
      (select coalesce(sum(spend_usd), 0) from trc.meta_daily
        where date >= (${from}::timestamptz at time zone 'America/Los_Angeles')::date
          and date < (${to}::timestamptz at time zone 'America/Los_Angeles')::date) as ad_spend,
      (select coalesce(sum(landing_page_views), 0)::int from trc.meta_daily
        where date >= (${from}::timestamptz at time zone 'America/Los_Angeles')::date
          and date < (${to}::timestamptz at time zone 'America/Los_Angeles')::date) as landing_page_views,
      (select count(distinct lower(email))::int from trc.registrations
        where created_at >= ${from} and created_at < ${to} and email is not null) as registrants,
      (select coalesce(sum(net_usd), 0) from trc.paid_payments where paid_at >= ${from} and paid_at < ${to}) as cash_all,
      (select coalesce(sum(p.net_usd), 0) from trc.paid_payments p
        where p.paid_at >= ${from} and p.paid_at < ${to}
          and exists (select 1 from trc.registrations r where lower(r.email) = p.email_key and r.session_at <= p.paid_at)) as cash_webinar`;

  const by_group = await sql<PeriodTotals["by_group"]>`
    select product_group, payment_type, count(*)::int as purchases, sum(cash_usd) as cash
    from trc.purchases where first_paid_at >= ${from} and first_paid_at < ${to}
    group by 1, 2 order by 1, 2`;

  // Failed or abandoned checkouts, and how many of those people paid later anyway.
  const [failed] = await sql<Array<PeriodTotals["failed"]>>`
    with f as (
      select lower(email) as email_key, total_usd, created_at from trc.whop_payments
      where status <> 'paid' and created_at >= ${from} and created_at < ${to}
    ),
    per_person as (select email_key, max(total_usd) as amount from f group by email_key)
    select count(*)::int as attempts,
           count(distinct email_key)::int as people,
           -- Retries are not added up: each person counts once, at their largest attempted amount.
           (select coalesce(sum(amount), 0) from per_person) as attempted_usd,
           (select count(distinct f2.email_key)::int from f f2
             where exists (select 1 from trc.paid_payments p where p.email_key = f2.email_key and p.paid_at >= f2.created_at)) as recovered_people
    from f`;

  return { ...base!, by_group, failed: failed! };
}

export async function lastSync() {
  const sql = db();
  const [row] = await sql<Array<{ started_at: Date; finished_at: Date | null; ok: boolean | null; detail: Record<string, { ok: boolean; skipped?: string; error?: string }> | null }>>`
    select started_at, finished_at, ok, detail from trc.sync_runs order by id desc limit 1`;
  return row ?? null;
}
