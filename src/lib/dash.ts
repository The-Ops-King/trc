import "server-only";
import { db } from "./db";
import { laDay } from "./metrics";
import { DEFAULT_TARGETS, TARGET_NAMES, type Targets } from "./targets";
import { PITCH_MINUTE } from "./config";

// The sections added with the PMU-style layout (2026-11-12): targets, results by ad, the daily chart, the high-ticket buyers
// list, and LTV : CAC. Every query reads the tables the sync fills; nothing here calls an outside service.

/** The last Pacific day inside [from, to). */
const lastDay = (to: Date) => laDay(new Date(to.getTime() - 1));

/** TRC's targets: GHL "KPI …" Custom Values over PMU's defaults (see targets.ts). */
export async function loadTargets(): Promise<Targets> {
  const rows = await db()<Array<{ name: string; value: number }>>`select name, value from trc.kpi_targets`;
  const t: Targets = { ...DEFAULT_TARGETS };
  for (const r of rows) { const k = TARGET_NAMES[r.name]; if (k) t[k] = r.value; }
  return t;
}

export type AdRow = {
  campaign: string | null;
  adset: string | null;
  ad: string | null;
  registrants: number;
  attended: number;          // Zoom only (the tracker has counts, not people)
  stayed: number;
  buyers: number;            // anyone who paid on Whop after registering
  ht_buyers: number;         // high-ticket (Ignite, Mastermind)
  ht_cash: number;
  spend: number | null;      // Meta, matched by the ad's names; null until Meta is connected
  impressions: number | null;
  link_clicks: number | null;
  status: string | null;
  thumbnail: string | null;
  frequency_7d: number | null;
};

/**
 * Registrations that came in during [from, to), by the ad in their UTMs (campaign / ad set / ad), and what those people did since.
 * Spend is Meta's for the same names in the same days (none until the Meta token is in).
 */
export async function resultsByAd(from: Date, to: Date): Promise<AdRow[]> {
  const sql = db();
  return sql<AdRow[]>`
    with reg as (
      select lower(email) as email_key, min(created_at) as first_at,
             -- someone who signed up twice counts under their first ad
             -- a value still holding Meta's macro ("{{ad.name}}", a preview click) names no ad
             (array_agg(case when utm_campaign like '{{%' then null else utm_campaign end order by created_at))[1] as campaign,
             (array_agg(case when utm_content like '{{%' then null else utm_content end order by created_at))[1] as adset,
             (array_agg(case when utm_term like '{{%' then null else utm_term end order by created_at))[1] as ad
      from trc.registrations
      where created_at >= ${from} and created_at < ${to} and email is not null
      group by lower(email)
    ),
    att as (
      select lower(za.email) as email_key,
             bool_or(za.last_leave_at >= zi.start_at + make_interval(mins => ${PITCH_MINUTE})) as stayed
      from trc.zoom_attendees za join trc.zoom_instances zi on zi.uuid = za.instance_uuid
      where zi.kind = 'webinar' and za.email is not null
      group by 1
    ),
    paid as (
      select email_key, min(paid_at) as first_paid,
             min(paid_at) filter (where product_group in ('ignite', 'mastermind')) as first_ht,
             coalesce(sum(net_usd) filter (where product_group in ('ignite', 'mastermind')), 0) as ht_cash
      from trc.paid_payments group by email_key
    ),
    people as (
      select reg.campaign, reg.adset, reg.ad,
             count(*)::int as registrants,
             count(att.email_key)::int as attended,
             count(*) filter (where att.stayed)::int as stayed,
             count(*) filter (where paid.first_paid >= reg.first_at)::int as buyers,
             count(*) filter (where paid.first_ht >= reg.first_at)::int as ht_buyers,
             coalesce(sum(paid.ht_cash) filter (where paid.first_ht >= reg.first_at), 0) as ht_cash
      from reg left join att using (email_key) left join paid using (email_key)
      group by 1, 2, 3
    ),
    spend as (
      select campaign_name as campaign, adset_name as adset, ad_name as ad,
             sum(spend_usd) as spend, sum(impressions)::float8 as impressions, sum(link_clicks)::float8 as link_clicks,
             (array_agg(ad_id order by date desc))[1] as ad_id
      from trc.meta_ad_daily
      where date between ${laDay(from)}::date and ${lastDay(to)}::date
      group by 1, 2, 3
    )
    select coalesce(p.campaign, s.campaign) as campaign, coalesce(p.adset, s.adset) as adset, coalesce(p.ad, s.ad) as ad,
           coalesce(p.registrants, 0) as registrants, coalesce(p.attended, 0) as attended, coalesce(p.stayed, 0) as stayed,
           coalesce(p.buyers, 0) as buyers, coalesce(p.ht_buyers, 0) as ht_buyers, coalesce(p.ht_cash, 0) as ht_cash,
           s.spend, s.impressions, s.link_clicks, ma.status, ma.thumbnail_url as thumbnail, ma.frequency_7d
    from people p
    full join spend s on coalesce(s.campaign, '') = coalesce(p.campaign, '') and coalesce(s.adset, '') = coalesce(p.adset, '') and coalesce(s.ad, '') = coalesce(p.ad, '')
    left join trc.meta_ads ma on ma.ad_id = s.ad_id
    order by coalesce(s.spend, 0) desc, coalesce(p.registrants, 0) desc`;
}

export type DayRow = { day: string; spend: number | null; registrants: number; attended: number | null };

/** One row per Pacific day in [from, to): ad spend (null on a day with no ad data), sign-ups, and webinar attendance that day. */
export async function daily(from: Date, to: Date): Promise<DayRow[]> {
  const sql = db();
  return sql<DayRow[]>`
    with days as (select generate_series(${laDay(from)}::date, ${lastDay(to)}::date, interval '1 day')::date as d),
    reg as (
      select (created_at at time zone 'America/Los_Angeles')::date as d, count(distinct lower(email))::int as n
      from trc.registrations where created_at >= ${from} and created_at < ${to} and email is not null group by 1
    ),
    zoom as (
      select (zi.session_at at time zone 'America/Los_Angeles')::date as d, count(distinct za.person_key)::int as n
      from trc.zoom_instances zi join trc.zoom_attendees za on za.instance_uuid = zi.uuid
      where zi.kind = 'webinar' group by 1
    ),
    sheet as (select date as d, show_ups as n from trc.sheet_webinar_day)
    select to_char(days.d, 'YYYY-MM-DD') as day, ad.spend_usd as spend, coalesce(reg.n, 0) as registrants,
           coalesce(zoom.n, sheet.n) as attended
    from days
    left join trc.ad_daily ad on ad.date = days.d
    left join reg on reg.d = days.d
    left join zoom on zoom.d = days.d
    left join sheet on sheet.d = days.d
    order by days.d`;
}

export type BuyerRow = {
  email: string;
  contact_id: string | null;
  product_group: string;
  first_paid_at: Date;
  cash: number;
  payment_type: string;
  session_at: Date | null;
  onboarding_attended: boolean | null;   // a Leap Welcome call before the first payment: true showed, false no-show, null none or unknown
};

/** High-ticket purchases (Ignite, Mastermind) whose first payment is in [from, to), newest first. */
export async function highTicketBuyers(from: Date, to: Date): Promise<BuyerRow[]> {
  const sql = db();
  return sql<BuyerRow[]>`
    select pa.email_key as email,
           (select contact_id from trc.registrations r where lower(r.email) = pa.email_key and contact_id is not null order by created_at desc limit 1) as contact_id,
           pa.product_group, pa.first_paid_at, pa.cash_usd as cash, pa.payment_type, pa.session_at,
           (select bool_or(o.attended) from trc.onboarding_attribution o
             where o.email_key = pa.email_key and o.start_at <= pa.first_paid_at and coalesce(o.appointment_status, '') <> 'cancelled') as onboarding_attended
    from trc.purchase_attribution pa
    where pa.product_group in ('ignite', 'mastermind') and pa.first_paid_at >= ${from} and pa.first_paid_at < ${to}
    order by pa.first_paid_at desc`;
}

export type LtvCac = {
  ltv: number | null;         // average Whop high-ticket cash per high-ticket buyer, every buyer so far
  ltv_buyers: number;
  new_buyers: number;         // people whose first high-ticket payment is in the period
  ad_spend: number;
  cac: number | null;         // ad spend in the period / new high-ticket buyers in the period
  ratio: number | null;
};

/**
 * LTV : CAC from what is connected today (Whop and ad spend): LTV is the cash a high-ticket buyer has paid on Whop so far, on
 * average; CAC is the period's ad spend per new high-ticket buyer. Churn (Kajabi) is not in it yet.
 */
export async function ltvCac(from: Date, to: Date, adSpend: number): Promise<LtvCac> {
  const sql = db();
  const [r] = await sql<Array<{ ltv: number | null; ltv_buyers: number; new_buyers: number }>>`
    with b as (
      select email_key, sum(net_usd) as cash, min(paid_at) as first_paid
      from trc.paid_payments where product_group in ('ignite', 'mastermind') group by email_key
    )
    select avg(cash) as ltv, count(*)::int as ltv_buyers,
           count(*) filter (where first_paid >= ${from} and first_paid < ${to})::int as new_buyers
    from b`;
  const cac = r!.new_buyers > 0 && adSpend > 0 ? adSpend / r!.new_buyers : null;
  return { ...r!, ad_spend: adSpend, cac, ratio: r!.ltv !== null && cac ? r!.ltv / cac : null };
}
