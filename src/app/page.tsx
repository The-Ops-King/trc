import { redirect } from "next/navigation";
import { hasSession } from "@/lib/guard";
import { env } from "@/lib/env";
import { loadDashboard, laDay, PITCH_MINUTE, type PeriodFunnel, type PeriodTotals, type SessionRow } from "@/lib/metrics";
import type { AdRow, LtvCac } from "@/lib/dash";
import { adKey, countPartials, partialsBy, type PartialCounts } from "@/lib/partials.ts";
import { judge, type Targets } from "@/lib/targets";
import { GROUP_LABEL, TYPE_LABEL, dateTime, div, num, pct, sessionLabel, usd } from "@/lib/format";
import { laWallTimeToUtc } from "@/lib/session";
import { Card, DailyChart, Delta, Info, Section } from "./ui";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RANGES = [7, 30, 60, 90] as const;
const DAY = 86_400_000;
/** Show a warning when the last successful sync is older than this (it runs every hour). */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
/** Give up well before Vercel's 60s limit, so a stalled database shows a message instead of a timeout page. */
const PAGE_DEADLINE_MS = 25_000;

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", ...o });
/** "Tue, Nov 10 · 9 AM" */
const sessionDay = (d: Date) => `${fmt({ weekday: "short", month: "short", day: "numeric" }).format(d)} · ${fmt({ hour: "numeric", minute: "2-digit" }).format(d).replace(":00", "")}`;
const shortDate = (d: Date) => fmt({ weekday: "short", month: "short", day: "numeric" }).format(d);
const shortDay = (ymd: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));
const pctOf = (r: number | null, digits = 1) => (r === null ? "—" : `${(r * 100).toFixed(digits)}%`);
const times = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}×`);
const rate = (x: number, y: number) => (y ? x / y : null);

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms); }),
  ]);
}

function sum<K extends keyof SessionRow>(rows: SessionRow[], k: K): number {
  return rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
}

/** Every number on the page from one period's data, so this period and the one before are computed the same way. */
function figures(t: PeriodTotals, f: PeriodFunnel, held: SessionRow[], ltv: LtvCac, pc: PartialCounts) {
  const a = held.filter((s) => s.attendees !== null);              // attendance from Zoom or the tracker
  const z = held.filter((s) => s.attendance_source === "zoom");    // stayed to pitch and attendee → buyer need Zoom
  const known = f.onb_booked - f.onb_unknown;
  const clicks = t.landing_page_views || t.link_clicks;
  return {
    adSpend: t.ad_spend,
    cpc: rate(t.ad_spend, t.link_clicks),
    outCtr: rate(t.outbound_clicks, t.impressions),
    signups: t.registrants,
    optIn: rate(t.registrants_on_ad_days, clicks),
    costPerReg: rate(t.ad_spend, t.registrants_on_ad_days),
    // partials (partials.ts): people who gave a name plus email or phone, and how many never booked a call
    gave: pc.gave,
    partials: pc.partials,
    partialRate: rate(pc.partials, pc.gave),
    // the cost metric: ad spend ÷ everyone who gave their contact on days with ad data (not ÷ partials, which rises as booking improves)
    costPerContact: rate(t.ad_spend, pc.gaveOnAdDays),
    registered: sum(held, "registrants"),
    attendees: sum(a, "attendees"),
    attRegs: sum(a, "registrants"),
    attendance: a.length ? rate(sum(a, "attendees"), sum(a, "registrants")) : null,
    zoomAttendees: sum(z, "attendees"),
    stayed: z.length ? rate(sum(z, "stayed_to_pitch"), sum(z, "attendees")) : null,
    buyers: sum(held, "buyers"),
    cash: sum(held, "cash"),
    lmBuys: sum(held, "lm_purchases"),
    lmCash: sum(held, "lm_cash"),
    attBuyer: z.length ? rate(sum(z, "attendee_buyers"), sum(z, "attendees")) : null,
    onbBooked: f.onb_booked,
    onbAttended: f.onb_attended,
    onbKnown: known,
    showRate: known > 0 ? f.onb_attended / known : null,
    htFromCalls: f.ht_after_onb_attended,
    callToHt: rate(f.ht_after_onb_attended, f.onb_attended),
    htCash: f.ht_cash,
    htBuyers: f.ht_buyers,
    pif: rate(f.ht_pif, f.ht_purchases),
    roas: rate(f.ht_cash, t.ad_spend),
    cac: ltv.cac,
    ltv: ltv.ltv,
    ltvCac: ltv.ratio,
    failed: t.failed.people,
  };
}

/** Cut / scale / watch for an ad, from the cost-per-high-ticket-buyer target (PMU's "KPI Max Cost Per Close"). Needs Meta spend. */
function verdict(r: AdRow, t: Targets): { key: string; label: string; why: string } | null {
  if (r.spend === null) return null;
  const max = t.costPerCloseMax ?? 3000;
  const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  if (r.spend < max) return { key: "early", label: "Too early", why: `Under ${usd0(max)} spent` };
  if (r.ht_buyers === 0 && r.spend >= 2 * max) return { key: "cut", label: "Cut", why: `${usd0(r.spend)} spent, no high-ticket buyers` };
  if (r.ht_buyers >= 2 && r.spend / r.ht_buyers <= max) return { key: "scale", label: "Scale", why: `${r.ht_buyers} high-ticket buyers at ${usd0(r.spend / r.ht_buyers)} each` };
  return { key: "watch", label: "Watch", why: "Not enough to call either way" };
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ days?: string; synced?: string; cmp?: string; from?: string; to?: string }> }) {
  if (!(await hasSession())) redirect("/login");
  const sp = await searchParams;
  // This week's webinars compare against last week's at the same point in time (default) or last week's final numbers.
  const cmp: "point" | "final" = sp.cmp === "final" ? "final" : "point";
  const now = new Date();
  // Whole Pacific days. Preset: the last `days` days including today. Custom: from/to (YYYY-MM-DD, both included, not after today).
  // The previous period is the same number of days just before.
  const startOfLaDay = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number) as [number, number, number]; return laWallTimeToUtc(y, m - 1, d, 0, 0); };
  const shiftDays = (ymd: string, n: number) => new Date(Date.UTC(...(ymd.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number]) + n * DAY).toISOString().slice(0, 10);
  const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
  const today = laDay(now);
  const ymdOk = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  const customTo = ymdOk(sp.to) && sp.to! <= today ? sp.to! : today;
  const custom = ymdOk(sp.from) && sp.from! <= customTo && daysBetween(sp.from!, customTo) < 400 ? { from: sp.from!, to: customTo } : null;
  const days = custom ? daysBetween(custom.from, custom.to) + 1 : RANGES.includes(Number(sp.days) as (typeof RANGES)[number]) ? Number(sp.days) : 30;
  const fromYmd = custom ? custom.from : shiftDays(today, -(days - 1));
  const toYmd = custom ? custom.to : today;
  const from = startOfLaDay(fromYmd);
  const to = toYmd === today ? now : startOfLaDay(shiftDays(toYmd, 1));
  const prevFrom = startOfLaDay(shiftDays(fromYmd, -days));
  const prevToYmd = shiftDays(fromYmd, -1);
  const periodLabel = custom ? `${shortDay(fromYmd)} – ${shortDay(toYmd)}` : `the last ${days} days (${shortDay(fromYmd)} – ${shortDay(toYmd)})`;
  const vsLabel = "vs before";
  const link = (o: { days?: number; cmp?: string; keepCustom?: boolean }) => {
    const c = (o.cmp ?? cmp) === "final" ? "&cmp=final" : "";
    return custom && o.keepCustom !== false && o.days === undefined ? `/?from=${custom.from}&to=${custom.to}${c}` : `/?days=${o.days ?? days}${c}`;
  };
  // Weeks run Monday to Sunday, Pacific.
  const isoDow = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const thisMonYmd = shiftDays(today, -(isoDow - 1));
  const weeks = { lastMon: startOfLaDay(shiftDays(thisMonYmd, -7)), thisMon: startOfLaDay(thisMonYmd), nextMon: startOfLaDay(shiftDays(thisMonYmd, 7)) };
  const weekRange = (monYmd: string) => `${shortDay(monYmd)} – ${shortDay(shiftDays(monYmd, 6))}`;

  let data;
  try {
    data = await withDeadline(
      loadDashboard(from, to, prevFrom, custom ? to : new Date(now.getTime() + 14 * DAY), weeks, (label, ms) => {
        if (ms > 2000) console.warn(`[dashboard] slow query ${label}: ${ms}ms`);
      }),
      PAGE_DEADLINE_MS,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dashboard] page data failed: ${message}`);
    const timedOut = message.startsWith("no answer within");
    return (
      <main>
        <div className="notice err">
          <b>The dashboard couldn&apos;t load its numbers.</b> {timedOut ? "The database didn't answer in time. Refresh in a minute; if it keeps happening, " : "A query failed; "}
          the cause is in the Vercel logs under &quot;[dashboard]&quot;.
        </div>
      </main>
    );
  }
  const { totals, funnel, sessions, sync, lastOk, pTotals, pFunnel, pSessions, weekSessions, thisWeekPeople, lastWeekPeople, lastWeekAsOf, targets: t, ads, days: dayRows, buyers, ltv, pLtv, funnelPeople } = data;
  const pc = countPartials(funnelPeople.people, from, to, funnelPeople.adDays, laDay);
  const ppc = countPartials(funnelPeople.people, prevFrom, from, funnelPeople.adDays, laDay);

  const metaOn = !!env.meta();
  const location = env.ghl()?.locationId ?? null;
  const minN = t.minSample ?? 10;
  // Ad spend: Meta when connected, else the team's tracker (FB Stats).
  const adOn = metaOn || totals.ad_source !== null || pTotals.ad_source !== null;
  const yesterday = shiftDays(today, -1);
  // The tracker's spend feed can stop (it did on 2026-11-03): say so instead of showing a low or $0 spend as if it were real.
  const adStale = !metaOn && totals.ad_last_any && totals.ad_last_any < (toYmd < yesterday ? toYmd : yesterday) ? totals.ad_last_any : null;
  const adNone = adOn && totals.ad_source === null;
  const adWarn = adStale ? `No ad data after ${shortDay(adStale)}${adNone ? "" : ": this period is incomplete"}` : undefined;
  /** A cost per registrant is only shown when spend exists for (nearly) every day its registrants signed up. */
  const spendComplete = (rows: number, covered: number) => rows > 0 && covered / rows >= 0.95;
  const clicksLabel = totals.landing_page_views ? "landing page views" : "link clicks";

  // Webinar numbers are per session: sessions held in the selected window.
  const held = sessions.filter((s) => s.session_at <= now && s.session_at < to);
  const cur = figures(totals, funnel, held, ltv, pc);
  const prev = figures(pTotals, pFunnel, pSessions, pLtv, ppc);
  const upcoming = custom ? [] : sessions.filter((s) => s.session_at > now).reverse();
  const inWeek = (start: Date, end: Date) => weekSessions.filter((x) => x.session_at >= start && x.session_at < end).slice().sort((a, b) => +a.session_at - +b.session_at);
  const thisWeek = inWeek(weeks.thisMon, weeks.nextMon), lastWeek = inWeek(weeks.lastMon, weeks.thisMon);
  const weekday = (d: Date) => fmt({ weekday: "short" }).format(d);
  const sameDayLastWeek = (x: SessionRow) => lastWeek.find((y) => weekday(y.session_at) === weekday(x.session_at)) ?? null;
  const weekRows = [
    { label: "This week", range: weekRange(thisMonYmd), sessions: thisWeek, people: thisWeekPeople, compare: true },
    { label: "Last week", range: weekRange(shiftDays(thisMonYmd, -7)), sessions: lastWeek, people: lastWeekPeople, compare: false },
  ];
  const withAtt = held.filter((s) => s.attendees !== null);
  const withZoom = held.filter((s) => s.attendance_source === "zoom");
  const fromTracker = withAtt.filter((s) => s.attendance_source === "tracker").length;
  const onbUnknown = funnel.onb_unknown;

  // targets → ok / miss / thin
  const f = {
    costPerContact: judge(cur.costPerContact, t.costPerRegistrantMax, pc.gaveOnAdDays, minN, true),
    optIn: judge(cur.optIn === null ? null : cur.optIn * 100, t.registrationRate, totals.registrants_on_ad_days, minN),
    attendance: judge(cur.attendance === null ? null : cur.attendance * 100, t.attendanceRate, cur.attRegs, minN),
    stayed: judge(cur.stayed === null ? null : cur.stayed * 100, t.stayedRate, cur.zoomAttendees, minN),
    attBuyer: judge(cur.attBuyer === null ? null : cur.attBuyer * 100, t.webinarConversion, cur.zoomAttendees, minN),
    show: judge(cur.showRate === null ? null : cur.showRate * 100, t.show, cur.onbKnown, minN),
    close: judge(cur.callToHt === null ? null : cur.callToHt * 100, t.close, cur.onbAttended, minN),
    pif: judge(cur.pif === null ? null : cur.pif * 100, t.pifRate, funnel.ht_purchases, minN),
    cac: judge(cur.cac, t.costPerCloseMax, ltv.new_buyers, 1, true),
    roas: judge(cur.roas, t.roasMin, funnel.ht_purchases, 1),
    ltvCac: judge(cur.ltvCac, t.ltvCacMin, ltv.new_buyers, 1),
  };
  const tgt = (v: number | undefined, unit: "%" | "$" | "x", max = false) =>
    v === undefined ? undefined : `${max ? "max " : "target "}${unit === "$" ? `$${v.toLocaleString("en-US")}` : unit === "x" ? `${v}×` : `${v}%`}`;

  // What makes these numbers less exact, said once, at the top (PMU's warnings panel).
  const stale = !lastOk || now.getTime() - lastOk.getTime() > STALE_AFTER_MS;
  const failedSources = Object.entries(sync?.detail ?? {}).filter(([, v]) => !v.ok).map(([k]) => k);
  const warnings: string[] = [];
  if (stale) warnings.push("The data is more than 3 hours old (it normally updates every hour). Press Sync now; if that fails, see Sync status at the bottom.");
  if (failedSources.length) warnings.push(`The last sync failed for: ${failedSources.join(", ")}. Details under Sync status at the bottom.`);
  if (!metaOn) warnings.push(`Meta isn't connected: ad spend, clicks, CPC and outbound CTR come from the team's tracker (FB Stats), and Results by ad has no spend per ad yet.`);
  if (adStale) warnings.push(`The tracker has no ad spend after ${shortDay(adStale)}, so spend for later days is missing and costs after that date aren't shown.`);
  if (fromTracker) warnings.push(`${fromTracker} of ${withAtt.length} webinars in this period take attendance from the team's tracker (typed in), not Zoom. Stayed to pitch and attendee → buyer count Zoom webinars only (from Nov 12).`);
  if (onbUnknown) warnings.push(`${num(onbUnknown)} onboarding call${onbUnknown === 1 ? " has" : "s have"} no showed / no-show mark in GHL and no Zoom match, so the show rate leaves ${onbUnknown === 1 ? "it" : "them"} out.`);
  if (funnelPeople.bookingsIncomplete) warnings.push(`Partials are too high for now: ${funnelPeople.bookingsIncomplete} (the hourly sync finishes this within a few hours), so some people who booked still count as partials.`);
  warnings.push("Churn needs Kajabi, which isn't connected. LTV is the cash a high-ticket buyer has paid on Whop so far; it will rise as payment plans and financing pay out.");
  if (!Object.keys(t).some((k) => !["minSample", "show", "close", "costPerCloseMax", "roasMin"].includes(k)))
    warnings.push("No webinar targets are set yet. Add them in GHL → Settings → Custom Values (\"KPI Max Cost Per Registrant\", \"KPI Attendance Rate\", …, listed under How each number is calculated); show rate, close rate, cost per high-ticket buyer and ROAS use PMU's defaults until then.");

  // Partials per ad (by the ad of the person's first registration) and per webinar (the one their first registration picked)
  const adPartials = partialsBy(funnelPeople.people, from, to, (p) => adKey(p.campaign, p.adset, p.ad));
  const known = new Set(ads.map((r) => adKey(r.campaign, r.adset, r.ad)));
  const blankAd = (k: string): AdRow => { const [campaign, adset, ad] = k.split("|").map((x) => x || null) as [string | null, string | null, string | null];
    return { campaign, adset, ad, registrants: 0, attended: 0, stayed: 0, buyers: 0, ht_buyers: 0, ht_cash: 0, spend: null, impressions: null, link_clicks: null, status: null, thumbnail: null, frequency_7d: null }; };
  const adRows = [...ads, ...[...adPartials.keys()].filter((k) => !known.has(k)).map(blankAd)]
    .filter((r) => r.registrants > 0 || (r.spend ?? 0) > 0 || adPartials.has(adKey(r.campaign, r.adset, r.ad)));
  const sessionPartials = partialsBy(funnelPeople.people, new Date(0), new Date(8.64e15), (p) => p.sessionAt?.toISOString() ?? "");
  const contactUrl = (id: string | null) => (id && location ? `https://app.tiffanyrosecoaching.com/v2/location/${location}/contacts/detail/${id}` : null);

  return (
    <>
      <div className="bar">
        <div className="bar-inner">
          <div className="bar-top">
            <div className="brand">
              <img src="/logo.png" alt="Tiffany Rose Coaching" />
              <div><span className="eyebrow">Tiffany Rose Coaching</span><h1>Webinar dashboard</h1></div>
            </div>
            <div className="meta">
              <span>{lastOk ? `Updated ${dateTime(lastOk)}` : "Not synced yet"}</span>
              <form method="post" action="/api/sync"><button className="primary" type="submit">Sync now</button></form>
              <form method="post" action="/api/logout"><button type="submit">Log out</button></form>
            </div>
          </div>
          <div className="bar-filters">
            <nav className="seg" aria-label="Date range">
              {RANGES.map((r) => <a key={r} href={link({ days: r })} className={!custom && r === days ? "active" : ""}>{r} days</a>)}
            </nav>
            <form method="get" action="/" className={`range-form${custom ? " active" : ""}`} aria-label="Custom dates">
              <input type="date" name="from" defaultValue={fromYmd} max={today} required aria-label="From" />
              <span className="muted small">to</span>
              <input type="date" name="to" defaultValue={toYmd} max={today} required aria-label="To" />
              {cmp === "final" && <input type="hidden" name="cmp" value="final" />}
              <button type="submit">Apply</button>
            </form>
          </div>
          <p className="summary">
            Showing <b>{periodLabel}</b> · compared with <b>{shortDay(shiftDays(fromYmd, -days))} – {shortDay(prevToYmd)}</b> · times Pacific
          </p>
        </div>
      </div>

      <main>
        {sp.synced === "error" && <div className="notice err">The sync you just ran failed for at least one source. See Sync status at the bottom.</div>}

        <div className="glance">
          <Card big title="Cost per contact captured" value={adNone || cur.costPerContact === null ? "—" : usd(cur.costPerContact, 2)}
            target={tgt(t.costPerRegistrantMax, "$", true)} flag={f.costPerContact} warn={adWarn}
            sub={`${usd(totals.ad_spend)} ad spend ÷ ${num(pc.gaveOnAdDays)} people who gave name and contact`}
            info={<><p>Ad spend ÷ everyone who gave their name plus an email or phone (a webinar registration), on days that have ad data.</p><p>People, not contacts: two contacts with the same name and email, or name and phone, are one person, dated by the first time they gave their contact.</p></>}
            delta={<Delta cur={cur.costPerContact} prev={prev.costPerContact} kind="count" better="down" label={vsLabel} money />} />
          <Card big title="Webinar attendance" value={pctOf(cur.attendance)} target={tgt(t.attendanceRate, "%")} flag={f.attendance}
            sub={`${num(cur.attendees)} of ${num(cur.attRegs)} registered`}
            info={<p>People who showed up ÷ people registered for that webinar, for webinars held in this period. From Zoom (Tiffany&apos;s room) when it has the webinar, otherwise the show-ups the team types into the tracker.</p>}
            delta={<Delta cur={cur.attendance} prev={prev.attendance} kind="rate" label={vsLabel} />} />
          <Card big title="Onboarding show rate" value={pctOf(cur.showRate)} target={tgt(t.show, "%")} flag={f.show}
            sub={`${num(funnel.onb_attended)} of ${num(cur.onbKnown)} calls with a result`}
            warn={onbUnknown ? `${num(onbUnknown)} without a result` : undefined}
            info={<p>Leap Welcome calls (and their reschedules) in this period: showed ÷ calls with a result. A call is showed when it&apos;s marked so in GHL or someone other than the team joined its Zoom meeting.</p>}
            delta={<Delta cur={cur.showRate} prev={prev.showRate} kind="rate" label={vsLabel} />} />
          <Card big title="Call → high ticket" value={pctOf(cur.callToHt)} target={tgt(t.close, "%")} flag={f.close}
            sub={`${num(funnel.ht_after_onb_attended)} high-ticket buyers of ${num(funnel.onb_attended)} who showed`}
            info={<p>People who bought Ignite or Mastermind on Whop after showing to an onboarding call, ÷ people who showed to one, in this period.</p>}
            delta={<Delta cur={cur.callToHt} prev={prev.callToHt} kind="rate" label={vsLabel} />} />
          <Card big title="High-ticket cash" value={usd(funnel.ht_cash)} target={tgt(t.roasMin, "x")} flag={f.roas}
            sub={`${times(cur.roas)} per $1 of ad spend`}
            info={<p>Whop cash for Ignite and Mastermind, net of refunds, by payment date. Its target is cash per $1 of ad spend (&quot;KPI Min ROAS&quot;).</p>}
            delta={<Delta cur={cur.htCash} prev={prev.htCash} kind="count" label={vsLabel} money />} />
        </div>

        {warnings.length > 0 && (
          <details className="warn-panel">
            <summary>{warnings.length} thing{warnings.length === 1 ? "" : "s"} that make these numbers less exact</summary>
            <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </details>
        )}

        <Section title="Ads" intro={<>Facebook ads for the webinar, {periodLabel}. {metaOn ? "From Meta." : "From the team's tracker (FB Stats, the Standout campaigns) until Meta is connected."}</>}>
          <div className="grid g4">
            <Card title="Ad spend" value={adNone ? "—" : usd(totals.ad_spend)} warn={adWarn} needs={adOn ? undefined : "Meta or the tracker"}
              sub={metaOn ? "Meta, webinar campaigns" : "tracker sheet, FB Stats"}
              delta={adNone || adStale ? undefined : <Delta cur={cur.adSpend} prev={prev.adSpend} kind="count" better="neither" label={vsLabel} money />} />
            <Card title="CPC" value={usd(cur.cpc, 2)} sub={`${num(totals.link_clicks)} link clicks`}
              info={<p>Ad spend ÷ link clicks (Meta&apos;s cost per link click).</p>}
              delta={<Delta cur={cur.cpc} prev={prev.cpc} kind="count" better="down" label={vsLabel} money />} />
            <Card title="Outbound CTR" value={pctOf(cur.outCtr, 2)} sub={`${num(totals.outbound_clicks)} outbound clicks · ${num(totals.impressions)} views`}
              info={<p>Clicks that left Facebook for the landing page ÷ times the ads were shown.</p>}
              delta={<Delta cur={cur.outCtr} prev={prev.outCtr} kind="rate" label={vsLabel} />} />
            <Card title="Registrations" value={num(cur.signups)} sub="people who signed up in these dates"
              info={<p>Unique people who filled out the webinar form in this period (GHL), whichever session they picked.</p>}
              delta={<Delta cur={cur.signups} prev={prev.signups} kind="count" label={vsLabel} />} />
            <Card n={2} title="Opt-in rate" value={pctOf(cur.optIn)} target={tgt(t.registrationRate, "%")} flag={f.optIn}
              sub={`${num(totals.registrants_on_ad_days)} sign-ups ÷ ${num(totals.landing_page_views || totals.link_clicks)} ${clicksLabel}`}
              info={<p>Sign-ups ÷ {clicksLabel}, counting only days that have ad data. Landing page views come with Meta; until then link clicks are used, as the tracker does.</p>}
              delta={<Delta cur={cur.optIn} prev={prev.optIn} kind="rate" label={vsLabel} />} />
            <Card title="Gave name and contact" value={num(pc.gave)} sub={`${num(pc.booked)} booked a call · ${num(pc.partials)} partials`}
              info={<p>People who gave their name plus an email or phone in these dates (the webinar form), counted once however many GHL contacts they have, dated by the first time they gave it.</p>}
              delta={<Delta cur={cur.gave} prev={prev.gave} kind="count" label={vsLabel} />} />
            <Card title="Partials" value={num(pc.partials)} sub={`${pctOf(cur.partialRate)} of ${num(pc.gave)} who gave name and contact`}
              info={<><p>People who gave their name and contact and have never booked a call on any of TRC&apos;s calendars, with Tiffany or Nick. A booking that was later cancelled or missed still counts as booked.</p><p>Test entries and the team are never partials.</p></>}
              delta={<Delta cur={cur.partials} prev={prev.partials} kind="count" better="down" label={vsLabel} />} />
            <Card n={1} title="Cost per contact captured" value={adNone || cur.costPerContact === null ? "—" : usd(cur.costPerContact, 2)} target={tgt(t.costPerRegistrantMax, "$", true)} flag={f.costPerContact}
              sub={`ad spend ÷ ${num(pc.gaveOnAdDays)} who gave name and contact on days with ad data`} warn={adWarn}
              delta={<Delta cur={cur.costPerContact} prev={prev.costPerContact} kind="count" better="down" label={vsLabel} money />} />
            <Card title="Registered" value={num(cur.registered)} sub={`for the ${held.length} webinar${held.length === 1 ? "" : "s"} held in these dates`}
              info={<p>Unique people registered for each webinar held in this period, added up across webinars (someone registered for two counts twice).</p>}
              delta={<Delta cur={cur.registered} prev={prev.registered} kind="count" label={vsLabel} />} />
          </div>

          {weekRows.map((w) => {
            const spend = w.sessions.reduce((a, x) => a + (Number(x.ad_spend) || 0), 0);
            const lastSpend = lastWeek.reduce((a, x) => a + (Number(x.ad_spend) || 0), 0);
            const weekComplete = spendComplete(sum(w.sessions, "reg_rows"), sum(w.sessions, "covered_rows"));
            const lastWeekComplete = spendComplete(sum(lastWeek, "reg_rows"), sum(lastWeek, "covered_rows"));
            const incomplete = <span className="pill warn">Cost per registrant: ad spend missing for some sign-up days</span>;
            return (
              <div key={w.label} className="week">
                <div className="row spread week-head">
                  <h3>{w.label} <span className="muted small">· {w.range}</span></h3>
                  {w.compare && (
                    <nav className="seg small-seg" aria-label="Compare this week with">
                      <span className="muted small">Compare with</span>
                      <a href={link({ cmp: "point" })} className={cmp === "point" ? "active" : ""}>Same point last week</a>
                      <a href={link({ cmp: "final" })} className={cmp === "final" ? "active" : ""}>Last week&apos;s final</a>
                    </nav>
                  )}
                </div>
                <div className={`grid ${w.sessions.length + 1 >= 4 ? "g4" : "g3"}`}>
                  {w.sessions.length === 0 && <div className="card metric"><div className="metric-title">No webinars this week</div></div>}
                  {w.sessions.map((x) => {
                    const ago = sameDayLastWeek(x);
                    const state = laDay(x.session_at) === today ? "today" : x.session_at > now ? "upcoming" : "held";
                    return (
                      <div key={x.session_at.toISOString()} className="card metric">
                        <div className="metric-head">
                          <span className="metric-title">{sessionDay(x.session_at)}</span>
                          <span className={`state ${state}`}>{state}</span>
                        </div>
                        <div className="metric-value">{num(x.registrants)}<span className="unit"> registered{state !== "held" ? " so far" : ""}</span></div>
                        {w.compare && ago && (() => {
                          const ref = cmp === "final" ? ago.registrants : (lastWeekAsOf.bySession.find((y) => +y.session_at === +ago.session_at)?.registrants ?? 0);
                          return <Delta cur={x.registrants} prev={ref} kind="count"
                            label={cmp === "final" ? `vs final for ${shortDate(ago.session_at)}` : `vs ${shortDate(ago.session_at)} at this point last week`} />;
                        })()}
                        <div className="metric-sub">
                          {!spendComplete(x.reg_rows, x.covered_rows) ? incomplete
                            : <span><b className="strong">{usd(div(x.ad_spend, x.registrants), 2)}</b> per registrant · {usd(x.ad_spend)} spend</span>}
                          {x.attendees !== null && <span>{num(x.attendees)} attended ({pct(x.attendees, x.registrants)}){x.stayed_to_pitch !== null ? ` · ${pct(x.stayed_to_pitch, x.attendees)} stayed to pitch` : ""} · {x.attendance_source === "zoom" ? "Zoom" : "tracker"}</span>}
                          {w.compare && ago && spendComplete(x.reg_rows, x.covered_rows) && spendComplete(ago.reg_rows, ago.covered_rows) &&
                            <Delta cur={div(x.ad_spend, x.registrants)} prev={div(ago.ad_spend, ago.registrants)} kind="count" better="down" label="cost per registrant" money />}
                        </div>
                      </div>
                    );
                  })}
                  <div className="card metric total">
                    <div className="metric-head"><span className="metric-title">{w.label} total</span>
                      <Info label={`${w.label} total`}><p>Unique people registered for any of this week&apos;s webinars: someone in both counts once, so this can be less than the cards added up.</p></Info></div>
                    <div className="metric-value">{num(w.people)}<span className="unit"> registered</span></div>
                    {w.compare && (() => {
                      const ref = cmp === "final" ? lastWeekPeople : lastWeekAsOf.total;
                      return <Delta cur={w.people} prev={ref} kind="count" label={cmp === "final" ? "vs last week (final)" : "vs last week at this point"} />;
                    })()}
                    <div className="metric-sub">
                      {!weekComplete ? incomplete : <span><b className="strong">{usd(div(spend, w.people), 2)}</b> per registrant · {usd(spend)} spend</span>}
                      {w.compare && weekComplete && lastWeekComplete &&
                        <Delta cur={div(spend, w.people)} prev={div(lastSpend, lastWeekPeople)} kind="count" better="down" label="cost per registrant" money />}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </Section>

        <Section title="Webinar" intro={<>The {held.length} webinar{held.length === 1 ? "" : "s"} held in {periodLabel}. Buyers belong to the last webinar they registered for before paying.</>}>
          <div className="grid g4">
            <Card n={3} title="Attendance rate" value={pctOf(cur.attendance)} target={tgt(t.attendanceRate, "%")} flag={f.attendance}
              sub={`${num(cur.attendees)} of ${num(cur.attRegs)} registered${fromTracker ? ` · ${fromTracker} from the tracker` : ""}`}
              needs={withAtt.length ? undefined : "Zoom or the tracker"}
              delta={<Delta cur={cur.attendance} prev={prev.attendance} kind="rate" label={vsLabel} />} />
            <Card n={4} title="Stayed to pitch" value={pctOf(cur.stayed)} target={tgt(t.stayedRate, "%")} flag={f.stayed}
              sub={`still on ${PITCH_MINUTE} min in · ${withZoom.length} Zoom webinar${withZoom.length === 1 ? "" : "s"}`}
              needs={withZoom.length ? undefined : "a Zoom webinar in these dates (from Nov 12)"}
              info={<p>Attendees still in Tiffany&apos;s Zoom room {PITCH_MINUTE} minutes after the start ÷ attendees. Zoom only: the tracker has counts, not who stayed.</p>}
              delta={<Delta cur={cur.stayed} prev={prev.stayed} kind="rate" label={vsLabel} />} />
            <Card n={5} title="Buyers from webinar" value={num(cur.buyers)} sub={`of ${num(cur.registered)} registered · Whop`}
              info={<p>People who paid on Whop after registering for one of these webinars (any product), each counted once.</p>}
              delta={<Delta cur={cur.buyers} prev={prev.buyers} kind="count" label={vsLabel} />} />
            <Card n={6} title="$ from webinar" value={usd(cur.cash)} sub="Whop cash from those buyers, net of refunds"
              delta={<Delta cur={cur.cash} prev={prev.cash} kind="count" label={vsLabel} money />} />
            <Card n={7} title="Attendee → buyer" value={pctOf(cur.attBuyer)} target={tgt(t.webinarConversion, "%")} flag={f.attBuyer}
              sub="attended in Zoom, then bought on Whop" needs={withZoom.length ? undefined : "a Zoom webinar in these dates (from Nov 12)"}
              info={<p>Attendees (Zoom, matched by email) who bought on Whop ÷ attendees. Zoom only: the tracker&apos;s show-ups have no names.</p>}
              delta={<Delta cur={cur.attBuyer} prev={prev.attBuyer} kind="rate" label={vsLabel} />} />
            <Card title="$97 sales on the webinar" value={usd(cur.lmCash)} sub={`${num(cur.lmBuys)} sales · ${pctOf(rate(cur.lmBuys, cur.attendees))} of attendees · tracker`}
              info={<p>The $97 offer sold on the webinar, as the team records it in the tracker (it&apos;s processed in an account this dashboard can&apos;t reach). Not part of $ from webinar.</p>}
              delta={<Delta cur={cur.lmCash} prev={prev.lmCash} kind="count" label={vsLabel} money />} />
          </div>
          {upcoming.length > 0 && (
            <p className="small muted">Next: {upcoming.map((s) => `${sessionLabel(s.session_at)} (${num(s.registrants)} registered)`).join(" · ")}</p>
          )}
        </Section>

        <Section title="Onboarding calls and high ticket" intro={<>Leap Welcome calls (and reschedules) by the day of the call; high-ticket sales (Ignite, Mastermind) from Whop by payment date.</>}>
          <div className="grid g4">
            <Card n={8} title="Onboarding calls attended" value={num(funnel.onb_attended)} sub={`of ${num(funnel.onb_booked)} booked`}
              warn={onbUnknown ? `${num(onbUnknown)} without a result` : undefined}
              delta={<Delta cur={cur.onbAttended} prev={prev.onbAttended} kind="count" label={vsLabel} />} />
            <Card n={9} title="Onboarding show rate" value={pctOf(cur.showRate)} target={tgt(t.show, "%")} flag={f.show}
              sub={`of ${num(cur.onbKnown)} calls with a result`}
              delta={<Delta cur={cur.showRate} prev={prev.showRate} kind="rate" label={vsLabel} />} />
            <Card n={10} title="High-ticket buyers from calls" value={num(funnel.ht_after_onb_attended)} sub={`of ${num(funnel.ht_buyers)} high-ticket buyers`}
              info={<p>Ignite or Mastermind buyers in this period who showed to an onboarding call before paying.</p>}
              delta={<Delta cur={cur.htFromCalls} prev={prev.htFromCalls} kind="count" label={vsLabel} />} />
            <Card n={11} title="Call → high ticket" value={pctOf(cur.callToHt)} target={tgt(t.close, "%")} flag={f.close}
              sub="of people who showed to a call"
              delta={<Delta cur={cur.callToHt} prev={prev.callToHt} kind="rate" label={vsLabel} />} />
            <Card n={12} title="High-ticket cash collected" value={usd(funnel.ht_cash)} sub={`all Whop: ${usd(totals.cash_all)}`}
              delta={<Delta cur={cur.htCash} prev={prev.htCash} kind="count" label={vsLabel} money />} />
            <Card n={13} title="Paid in full" value={pctOf(cur.pif)} target={tgt(t.pifRate, "%")} flag={f.pif}
              sub={`${num(funnel.ht_pif)} PIF · ${num(funnel.ht_financing)} third-party financing · ${num(funnel.ht_plan)} payment plan`}
              info={<p>High-ticket purchases paid in full (card or PayPal, all within 7 days of the first payment; deposit + balance counts) ÷ all high-ticket purchases. Third-party financing = Sezzle, Klarna, Afterpay, ClarityPay, Splitit. Payment plan = Whop splits it.</p>}
              delta={<Delta cur={cur.pif} prev={prev.pif} kind="rate" label={vsLabel} />} />
            <Card title="Failed / abandoned checkouts" value={num(totals.failed.people)}
              sub={`${usd(totals.failed.attempted_usd)} attempted · ${num(totals.failed.recovered_people)} paid later`}
              info={<p>Whop checkouts that failed or were left unfinished (most are declined financing applications). Each person counts once, at their largest attempt.</p>}
              delta={<Delta cur={cur.failed} prev={prev.failed} kind="count" better="down" label={vsLabel} />} />
            <div className="card metric">
              <div className="metric-head"><span className="metric-title">Offer mix</span></div>
              <table className="mini"><tbody>
                {totals.by_group.length === 0 && <tr><td className="muted">No purchases</td></tr>}
                {totals.by_group.map((g) => (
                  <tr key={`${g.product_group}-${g.payment_type}`}>
                    <td>{GROUP_LABEL[g.product_group] ?? g.product_group} · {TYPE_LABEL[g.payment_type] ?? g.payment_type}</td>
                    <td>{num(g.purchases)}</td><td>{usd(g.cash)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          </div>
        </Section>

        <Section title="Retention and unit economics">
          <div className="grid g4">
            <Card n={14} title="Churn" value="—" needs="Kajabi" target={tgt(t.churnMax, "%", true)} />
            <Card n={15} title="LTV : CAC" value={cur.ltvCac === null ? "—" : `${cur.ltvCac.toFixed(1)} : 1`} target={tgt(t.ltvCacMin, "x")} flag={f.ltvCac}
              sub={`LTV ${usd(ltv.ltv)} · CAC ${usd(ltv.cac)}`}
              info={<><p><b>LTV</b>: the Whop cash a high-ticket buyer has paid so far, on average ({num(ltv.ltv_buyers)} buyers to date).</p><p><b>CAC</b>: ad spend in this period ÷ new high-ticket buyers in this period ({num(ltv.new_buyers)}).</p><p>Churn (Kajabi) isn&apos;t in it yet.</p></>}
              delta={<Delta cur={cur.ltvCac} prev={prev.ltvCac} kind="count" label={vsLabel} />} />
            <Card title="Cost per high-ticket buyer" value={usd(cur.cac)} target={tgt(t.costPerCloseMax, "$", true)} flag={f.cac}
              sub={`${usd(totals.ad_spend)} ÷ ${num(ltv.new_buyers)} new buyers`} warn={adWarn}
              delta={<Delta cur={cur.cac} prev={prev.cac} kind="count" better="down" label={vsLabel} money />} />
            <Card title="Cash per $1 of ads" value={times(cur.roas)} target={tgt(t.roasMin, "x")} flag={f.roas}
              sub="high-ticket cash ÷ ad spend" warn={adWarn}
              delta={<Delta cur={cur.roas} prev={prev.roas} kind="count" label={vsLabel} />} />
          </div>
        </Section>

        <Section title="Daily ad spend and sign-ups" intro="Ad spend each day next to webinar sign-ups and attendance, to see whether more spend brings more people. Hover a day for its numbers.">
          <DailyChart days={dayRows} />
        </Section>

        <Section title="16 · Results by ad"
          intro={<>Everyone who signed up in these dates, by the ad in their link (campaign / ad set / ad), and what they did since. {metaOn
            ? `Verdict: Cut = ${usd(2 * (t.costPerCloseMax ?? 3000))} spent with no high-ticket buyer; Scale = 2+ high-ticket buyers at ${usd(t.costPerCloseMax ?? 3000)} or less each; Too early = under ${usd(t.costPerCloseMax ?? 3000)} spent.`
            : "Spend, cost per contact captured and the cut / scale call per ad arrive with the Meta token."} Gave name and contact, booked and partials count people by the ad of their first registration (gave = booked + partials on every row). Attended and stayed come from Zoom (Nov 12 on).</>}>
          <div className="table-wrap">
            <table className="ads-table">
              <thead>
                <tr>
                  <th>Ad</th><th>Verdict</th><th>Spend</th><th>Registered</th><th>Gave name and contact</th><th>Booked a call</th><th>Partials</th><th>Cost / contact captured</th><th>Attended</th><th>Stayed to pitch</th>
                  <th>Bought (Whop)</th><th>High-ticket buyers</th><th>High-ticket cash</th><th>Cost / HT buyer</th><th>Cash per $1</th><th>CTR</th><th>Views / person (7d)</th>
                </tr>
              </thead>
              <tbody>
                {adRows.length === 0 && <tr><td colSpan={17} className="muted">No sign-ups in these dates.</td></tr>}
                {adRows.map((r) => {
                  const v = verdict(r, t);
                  const unknown = !r.ad && !r.adset && !r.campaign;
                  const pr = adPartials.get(adKey(r.campaign, r.adset, r.ad)) ?? { gave: 0, booked: 0, partials: 0 };
                  return (
                    <tr key={`${r.campaign}|${r.adset}|${r.ad}`}>
                      <td className="ad-cell">
                        {r.thumbnail ? <img src={r.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
                        <span><b>{unknown ? "No ad in the link" : r.ad ?? "—"}</b>
                          <span className="muted small">{unknown ? "organic, email, SMS or a link without UTMs" : [r.adset, r.campaign].filter(Boolean).join(" · ")}{r.status ? ` · ${r.status.toLowerCase()}` : ""}</span></span>
                      </td>
                      <td>{v ? <span className={`v ${v.key}`} title={v.why}>{v.label}</span> : <span className="muted">—</span>}</td>
                      <td>{r.spend === null ? <span className="muted">—</span> : usd(r.spend)}</td>
                      <td>{num(r.registrants)}</td>
                      <td>{num(pr.gave)}</td>
                      <td>{num(pr.booked)}</td>
                      <td>{num(pr.partials)} <span className="muted small">{pr.gave ? pctOf(pr.partials / pr.gave, 0) : ""}</span></td>
                      <td>{r.spend !== null && pr.gave ? usd(r.spend / pr.gave, 2) : <span className="muted">—</span>}</td>
                      <td>{num(r.attended)}</td>
                      <td>{num(r.stayed)}</td>
                      <td>{num(r.buyers)}</td>
                      <td>{num(r.ht_buyers)}</td>
                      <td>{usd(r.ht_cash)}</td>
                      <td>{r.spend !== null && r.ht_buyers ? usd(r.spend / r.ht_buyers) : <span className="muted">—</span>}</td>
                      <td>{r.spend ? times(r.ht_cash / r.spend) : <span className="muted">—</span>}</td>
                      <td>{r.impressions ? pctOf((r.link_clicks ?? 0) / r.impressions, 2) : <span className="muted">—</span>}</td>
                      <td className={r.frequency_7d && r.frequency_7d > 3 ? "bad" : ""}>{r.frequency_7d ? r.frequency_7d.toFixed(1) : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Webinars, one by one" intro="Each webinar held in these dates. Spend per webinar splits each day's spend across the webinars people signed up for that day. Gave contact and partials count people under the webinar their first registration picked.">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Webinar</th><th>Registered</th><th>Gave contact</th><th>Partials</th><th>Spend</th><th>Cost / reg</th><th>Attended</th><th>Stayed</th>
                  <th>Buyers</th><th>Cash</th><th>$97 sales</th><th>Onboarding showed</th><th>HT cash</th><th>PIF</th>
                </tr>
              </thead>
              <tbody>
                {held.length === 0 && <tr><td colSpan={14} className="muted">No webinars in these dates.</td></tr>}
                {held.map((s) => (
                  <tr key={s.session_at.toISOString()}>
                    <td>{sessionLabel(s.session_at)}</td>
                    <td>{num(s.registrants)}</td>
                    {(() => { const sp = sessionPartials.get(s.session_at.toISOString()) ?? { gave: 0, booked: 0, partials: 0 };
                      return <><td>{num(sp.gave)}</td><td>{num(sp.partials)} <span className="muted small">{sp.gave ? pctOf(sp.partials / sp.gave, 0) : ""}</span></td></>; })()}
                    <td>{spendComplete(s.reg_rows, s.covered_rows) ? usd(s.ad_spend) : <span className="muted" title="ad spend missing for some sign-up days">—</span>}</td>
                    <td>{spendComplete(s.reg_rows, s.covered_rows) ? usd(div(s.ad_spend, s.registrants), 2) : <span className="muted" title="ad spend missing for some sign-up days">—</span>}</td>
                    <td>{s.attendees === null ? "—" : <>{num(s.attendees)} · {pct(s.attendees, s.registrants)} <span className="muted small">{s.attendance_source === "zoom" ? "Zoom" : "tracker"}</span></>}</td>
                    <td>{s.stayed_to_pitch === null ? "—" : pct(s.stayed_to_pitch, s.attendees)}</td>
                    <td>{num(s.buyers)}</td>
                    <td>{usd(s.cash)}</td>
                    <td>{s.lm_purchases ? `${num(s.lm_purchases)} · ${usd(s.lm_cash)}` : "—"}</td>
                    <td>{num(s.onb_attended)} <span className="muted small">/ {num(s.onb_booked)}</span></td>
                    <td>{usd(s.ht_cash)}</td>
                    <td>{pct(s.ht_pif, s.ht_purchases)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="High-ticket buyers" intro="Everyone whose first Ignite or Mastermind payment on Whop falls in these dates. Click a name to open them in GHL.">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Buyer</th><th>Offer</th><th>First paid</th><th>Cash so far</th><th>How they paid</th><th>Webinar</th><th>Onboarding call</th></tr></thead>
              <tbody>
                {buyers.length === 0 && <tr><td colSpan={7} className="muted">No high-ticket buyers in these dates.</td></tr>}
                {buyers.map((b) => {
                  const href = contactUrl(b.contact_id);
                  return (
                    <tr key={`${b.email}|${b.product_group}`}>
                      <td>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{b.email}</a> : b.email}</td>
                      <td>{GROUP_LABEL[b.product_group] ?? b.product_group}</td>
                      <td>{shortDate(b.first_paid_at)}</td>
                      <td>{usd(b.cash)}</td>
                      <td>{TYPE_LABEL[b.payment_type] ?? b.payment_type}</td>
                      <td>{b.session_at ? sessionLabel(b.session_at) : <span className="muted">none before buying</span>}</td>
                      <td>{b.onboarding_attended === true ? "Showed" : b.onboarding_attended === false ? "No-show" : <span className="muted">none or unknown</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>

        <details className="more">
          <summary>How each number is calculated</summary>
          <ul className="defs">
            <li><b>Numbered cards (1–16)</b> follow the KPI list. Webinar numbers cover webinars held in the selected dates; a purchase belongs to the most recent webinar the buyer registered for before paying (matched by email).</li>
            <li><b>Gave name and contact</b> = people who gave a name plus an email or phone (the webinar form) in the dates, counted once however many GHL contacts they have (same name and email, or same name and phone, is one person), dated by the first time they gave it. <b>Partials</b> = those who have never booked a call on any of TRC&apos;s calendars, with Tiffany or Nick; a cancelled or missed booking still counts as booked. <b>Cost per contact captured</b> = ad spend ÷ everyone who gave name and contact (not ÷ partials: that would rise exactly when booking improves). Test entries and the team (GHL users, TRC and agency addresses) are left out of every number on the page.</li>
            <li><b>Attendance</b> = people who showed up ÷ people registered. From Zoom (Tiffany&apos;s Personal Meeting Room is the webinar) when it has the webinar; before Nov 12, the show-ups the team types into the tracker. <b>Stayed to pitch</b> = still in the room {PITCH_MINUTE} minutes after it started (Zoom only).</li>
            <li><b>Onboarding</b> = Leap Welcome Calls, including reschedules. Showed = marked so in GHL, otherwise someone other than the team joined the call&apos;s Zoom meeting.</li>
            <li><b>High ticket</b> = Ignite and Mastermind on Whop. <b>Cash</b> = Whop payments net of refunds; failed checkouts never count. <b>Paid in full</b> = card/PayPal, all within 7 days of the first payment. <b>Third-party financing</b> = Sezzle, Klarna, Afterpay, ClarityPay or Splitit. <b>Payment plan</b> = Whop splits it.</li>
            <li><b>Ad spend, clicks, CPC, outbound CTR</b> = the webinar campaigns: from Meta once connected, until then the tracker&apos;s FB Stats (Standout campaigns). <b>Opt-in rate</b> = sign-ups ÷ link clicks (landing page views once Meta is in).</li>
            <li><b>Targets</b> come from GHL → Settings → Custom Values, named as on PMU&apos;s dashboard: &quot;KPI Show Rate&quot;, &quot;KPI Close Rate&quot;, &quot;KPI Max Cost Per Close&quot;, &quot;KPI Min ROAS&quot;, &quot;KPI Min Sample&quot;, plus TRC&apos;s own: &quot;KPI Max Cost Per Registrant&quot;, &quot;KPI Registration Rate&quot;, &quot;KPI Attendance Rate&quot;, &quot;KPI Stayed To Pitch Rate&quot;, &quot;KPI Webinar Conversion Rate&quot;, &quot;KPI PIF Rate&quot;, &quot;KPI Max Churn Rate&quot;, &quot;KPI Min LTV CAC&quot;. Rates are percents. A group smaller than the minimum sample is marked &quot;Too few to judge&quot;.</li>
          </ul>
        </details>

        <details className="more">
          <summary>Sync status</summary>
          <div className="small" style={{ padding: "8px 2px" }}>
            {sync ? <div className="muted">Last run {dateTime(sync.started_at)}</div> : <div className="muted">No sync yet.</div>}
            {Object.entries(sync?.detail ?? {}).map(([k, v]) => (
              <div key={k}><b>{k}</b>: {v.skipped ? "not connected" : v.ok ? "ok" : <span style={{ color: "var(--bad)" }}>{v.error}</span>}</div>
            ))}
          </div>
        </details>
      </main>
    </>
  );
}
