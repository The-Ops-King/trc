import { redirect } from "next/navigation";
import { hasSession } from "@/lib/guard";
import { env } from "@/lib/env";
import {
  loadDashboard, PITCH_MINUTE, type SessionRow,
} from "@/lib/metrics";
import { GROUP_LABEL, TYPE_LABEL, dateTime, div, num, pct, sessionLabel, usd } from "@/lib/format";
import { laWallTimeToUtc } from "@/lib/session";
import { laDay, type PeriodFunnel, type PeriodTotals } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RANGES = [7, 30, 60, 90] as const;
const DAY = 86_400_000;
/** Show a warning when the last successful sync is older than this. */
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", ...o });
/** "Tue, Nov 10 · 9 AM" */
const sessionDay = (d: Date) => `${fmt({ weekday: "short", month: "short", day: "numeric" }).format(d)} · ${fmt({ hour: "numeric", minute: "2-digit" }).format(d).replace(":00", "")}`;
/** "Nov 3" */
const shortDate = (d: Date) => fmt({ weekday: "short", month: "short", day: "numeric" }).format(d);
/** "Nov 9" from a YYYY-MM-DD Pacific day */
const shortDay = (ymd: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));

/** Give up well before Vercel's 60s limit, so a stalled database shows a message instead of a timeout page. */
const PAGE_DEADLINE_MS = 25_000;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms); }),
  ]);
}


type CardState = { needs?: string; warn?: string };

function Card({ n, title, value, sub, help, state = {}, delta }: {
  n: number; title: string; value: string; sub?: string; help: string; state?: CardState; delta?: React.ReactNode;
}) {
  const blocked = !!state.needs;
  return (
    <div className={`card metric${blocked ? " blocked" : ""}`} title={help}>
      <div className="metric-head">
        <span className="tag">{n}</span>
        <span className="metric-title">{title}</span>
      </div>
      <div className="metric-value">{blocked ? "—" : value}</div>
      {!blocked && delta}
      <div className="metric-sub">
        {blocked ? <span className="pill">Connect {state.needs}</span> : sub}
        {!blocked && state.warn && <span className="pill warn">{state.warn}</span>}
      </div>
    </div>
  );
}

function sum<K extends keyof SessionRow>(rows: SessionRow[], k: K): number {
  return rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
}

/** Every number on a card, from one period's data, so this period and the one before are computed the same way. */
function figures(t: PeriodTotals, f: PeriodFunnel, held: SessionRow[]) {
  const a = held.filter((s) => s.attendees !== null); // attendance from Zoom or the tracker sheet
  const z = held.filter((s) => s.attendance_source === "zoom"); // stayed-to-pitch and attendee → buyer need Zoom
  const known = f.onb_booked - f.onb_unknown;
  const rate = (x: number, y: number) => (y ? x / y : null);
  return {
    adSpend: t.ad_spend,
    regRate: rate(t.registrants_on_ad_days, t.landing_page_views || t.link_clicks),
    attendance: a.length ? rate(sum(a, "attendees"), sum(a, "registrants")) : null,
    stayed: z.length ? rate(sum(z, "stayed_to_pitch"), sum(z, "attendees")) : null,
    buyers: sum(held, "buyers"),
    cash: sum(held, "cash"),
    lmCash: sum(held, "lm_cash"),
    attBuyer: z.length ? rate(sum(z, "attendee_buyers"), sum(z, "attendees")) : null,
    onbAttended: f.onb_attended,
    showRate: known > 0 ? f.onb_attended / known : null,
    htFromCalls: f.ht_after_onb_attended,
    callToHt: rate(f.ht_after_onb_attended, f.onb_attended),
    htCash: f.ht_cash,
    pif: rate(f.ht_pif, f.ht_purchases),
    failed: t.failed.people,
  };
}

/**
 * Change against the previous period of the same length. Counts and dollars: % change. Rates: percentage points, since a %
 * change of a % is easy to misread. `better` says which way is good (green) for this number.
 */
function Delta({ cur, prev, kind, better = "up", label }: { cur: number | null; prev: number | null; kind: "count" | "rate"; better?: "up" | "down" | "neither"; label: string }) {
  if (cur === null || prev === null) return <div className="delta flat">no comparison · {label}</div>;
  const diff = cur - prev;
  if (Math.abs(diff) < 1e-9) return <div className="delta flat">no change · {label}</div>;
  const good = (diff > 0) === (better === "up");
  const arrow = diff > 0 ? "▲" : "▼";
  let text: string;
  if (kind === "rate") text = `${diff > 0 ? "+" : "−"}${Math.abs(diff * 100).toFixed(1)} pts`;
  else if (prev === 0) text = "new";
  else text = `${diff > 0 ? "+" : "−"}${Math.abs((diff / prev) * 100).toFixed(1)}%`;
  return <div className={`delta ${better === "neither" ? "neutral" : good ? "good" : "bad"}`}>{arrow} {text} <span className="muted">· {label}</span></div>;
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
  const periodLabel = custom ? `${shortDay(fromYmd)} – ${shortDay(toYmd)}` : `last ${days} days`;
  const vsLabel = `vs previous ${days} day${days === 1 ? "" : "s"}`;
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
    console.error(`[dashboard] page data failed: ${err instanceof Error ? err.message : String(err)}`);
    return (
      <main>
        <div className="notice err">
          <b>The dashboard couldn&apos;t load its numbers.</b> The database didn&apos;t answer in time. Refresh in a minute; if it keeps
          happening, the cause is in the Vercel logs under &quot;[dashboard]&quot;.
        </div>
      </main>
    );
  }
  const { totals, funnel, sessions, sync, lastOk, pTotals, pFunnel, pSessions, weekSessions, thisWeekPeople, lastWeekPeople, lastWeekAsOf } = data;

  const metaOn = !!env.meta();
  const zoomOn = !!env.zoom();
  // Ad spend: Meta when connected, else the team's tracker sheet (FB Stats).
  const adOn = metaOn || totals.ad_source !== null || pTotals.ad_source !== null;
  const needMeta: CardState = adOn ? {} : { needs: "Meta Ads" };
  const adFromSheet = totals.ad_source === "sheet" || totals.ad_source === "mixed";
  const yesterday = shiftDays(today, -1);
  // The tracker's spend feed can stop (it did on 2026-11-03): say so instead of showing a low or $0 spend as if it were real.
  const adStale = !metaOn && totals.ad_last_any && totals.ad_last_any < (toYmd < yesterday ? toYmd : yesterday) ? totals.ad_last_any : null;
  const adNone = adOn && totals.ad_source === null; // no spend recorded anywhere in this window
  const adState: CardState = adOn ? (adStale ? { warn: `Tracker has no ad spend after ${shortDay(adStale)}${adNone ? "" : ": this period is incomplete"}` } : {}) : needMeta;
  /** A cost per registrant is only shown when spend exists for (nearly) every day its registrants signed up. */
  const spendComplete = (rows: number, covered: number) => rows > 0 && covered / rows >= 0.95;
  const incomplete = <span className="pill warn">Cost per registrant: ad spend missing for some sign-up days{adStale ? ` (tracker stopped ${shortDay(adStale)})` : ""}</span>;
  const regDenom = totals.landing_page_views ? { n: totals.landing_page_views, label: "landing page views" } : { n: totals.link_clicks, label: "link clicks" };

  // Webinar numbers (4-8) are per session: sessions held in the selected window.
  const held = sessions.filter((s) => s.session_at <= now && s.session_at < to);
  const cur = figures(totals, funnel, held);
  const prev = figures(pTotals, pFunnel, pSessions);
  const upcoming = custom ? [] : sessions.filter((s) => s.session_at > now).reverse();
  // This week's and last week's webinars, each by its own date.
  const inWeek = (start: Date, end: Date) => weekSessions.filter((x) => x.session_at >= start && x.session_at < end).slice().sort((a, b) => +a.session_at - +b.session_at);
  const thisWeek = inWeek(weeks.thisMon, weeks.nextMon), lastWeek = inWeek(weeks.lastMon, weeks.thisMon);
  const weekday = (d: Date) => fmt({ weekday: "short" }).format(d);
  // the same weekday last week (by Pacific weekday, so a daylight-saving change in between does not break the match)
  const sameDayLastWeek = (x: SessionRow) => lastWeek.find((y) => weekday(y.session_at) === weekday(x.session_at)) ?? null;
  const weekRows = [
    { label: "This week", range: weekRange(thisMonYmd), sessions: thisWeek, people: thisWeekPeople, compare: true },
    { label: "Last week", range: weekRange(shiftDays(thisMonYmd, -7)), sessions: lastWeek, people: lastWeekPeople, compare: false },
  ];

  const withAtt = held.filter((s) => s.attendees !== null);
  const withZoom = held.filter((s) => s.attendance_source === "zoom");
  const attFromTracker = withAtt.some((s) => s.attendance_source === "tracker");
  const needZoom: CardState = withZoom.length ? {} : { needs: "Zoom" };
  const regsHeld = sum(held, "registrants");
  const attendees = sum(withAtt, "attendees");
  const regsWithAtt = sum(withAtt, "registrants");
  const zoomAttendees = sum(withZoom, "attendees");

  // Onboarding attendance is only meaningful for calls with a known result.
  const onbKnown = funnel.onb_booked - funnel.onb_unknown;
  const onbWarn: CardState =
    funnel.onb_unknown > 0 ? { warn: `${num(funnel.onb_unknown)} call${funnel.onb_unknown === 1 ? "" : "s"} with no attendance recorded` } : {};

  const stale = !lastOk || now.getTime() - lastOk.getTime() > STALE_AFTER_MS;
  const failedSources = Object.entries(sync?.detail ?? {}).filter(([, v]) => !v.ok).map(([k]) => k);

  return (
    <main>
      <header className="row spread">
        <div className="row" style={{ gap: 20 }}>
          <div className="brand">
            <img src="/logo.png" alt="Tiffany Rose Coaching" />
            <div><span className="eyebrow">Tiffany Rose Coaching</span><h1>Funnel Dashboard</h1></div>
          </div>
          <nav className="seg row" style={{ gap: 0 }} aria-label="Date range">
            {RANGES.map((r) => (
              <a key={r} href={link({ days: r })} className={!custom && r === days ? "active" : ""}>{r === 7 ? "7 days" : `${r} days`}</a>
            ))}
          </nav>
          <form method="get" action="/" className={`range-form${custom ? " active" : ""}`} aria-label="Custom dates">
            <input type="date" name="from" defaultValue={fromYmd} max={today} required aria-label="From" />
            <span className="muted small">to</span>
            <input type="date" name="to" defaultValue={toYmd} max={today} required aria-label="To" />
            {cmp === "final" && <input type="hidden" name="cmp" value="final" />}
            <button type="submit">Apply</button>
          </form>
        </div>
        <div className="row">
          <span className="small muted">{lastOk ? `Updated ${dateTime(lastOk)}` : "Not synced yet"}</span>
          <form method="post" action="/api/sync"><button className="primary" type="submit">Sync now</button></form>
          <form method="post" action="/api/logout"><button type="submit">Log out</button></form>
        </div>
      </header>

      {(stale || failedSources.length > 0 || sp.synced === "error") && (
        <div className="notice err">
          {stale && <div>Data is more than 36 hours old. Press <b>Sync now</b>; if that fails, check the sync status at the bottom of the page.</div>}
          {failedSources.length > 0 && <div>Last sync failed for: {failedSources.join(", ")}. Details at the bottom of the page.</div>}
        </div>
      )}

      <section>
        <h2>Ads <span className="muted small">· {periodLabel}</span></h2>
        <div className="grid g2">
          <Card n={1} title="Ad spend" value={adNone ? "—" : usd(totals.ad_spend)}
            sub={adFromSheet || !metaOn ? "webinar campaigns · from the team's tracker sheet (FB Stats)" : "Meta Ads, webinar campaigns"}
            help="Facebook spend on the webinar campaigns in the selected period. From Meta when connected, otherwise from the team's tracker sheet." state={adState}
            delta={adNone || adStale ? undefined : <Delta cur={cur.adSpend} prev={prev.adSpend} kind="count" better="neither" label={vsLabel} />} />
          <Card n={3} title="Registration rate" value={pct(totals.registrants_on_ad_days, regDenom.n)}
            sub={`${num(totals.registrants_on_ad_days)} registrants · ${num(regDenom.n)} ${regDenom.label}${totals.registrants_on_ad_days < totals.registrants ? " (days with ad data only)" : ""}`}
            help={`Registrants ÷ ${regDenom.label}, counting only days that have ad data. Landing page views come with the Meta connection; until then the tracker sheet's link clicks are used.`} state={adState}
            delta={<Delta cur={cur.regRate} prev={prev.regRate} kind="rate" label={vsLabel} />} />
        </div>
        {weekRows.map((w) => {
          const spend = w.sessions.reduce((t, x) => t + (Number(x.ad_spend) || 0), 0);
          const lastSpend = lastWeek.reduce((t, x) => t + (Number(x.ad_spend) || 0), 0);
          const weekComplete = spendComplete(sum(w.sessions, "reg_rows"), sum(w.sessions, "covered_rows"));
          const lastWeekComplete = spendComplete(sum(lastWeek, "reg_rows"), sum(lastWeek, "covered_rows"));
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
                  const state = x.session_at > now ? (laDay(x.session_at) === today ? "today" : "upcoming") : (laDay(x.session_at) === today ? "today" : "held");
                  return (
                    <div key={x.session_at.toISOString()} className="card metric"
                      title="Unique people registered for this webinar (all registrations, whenever they signed up). Cost per registrant: Meta spend on the days they signed up, split across that day's registrations.">
                      <div className="metric-head">
                        <span className="tag">2</span><span className="metric-title">{sessionDay(x.session_at)}</span>
                        <span className={`state ${state}`}>{state === "today" ? "today" : state === "upcoming" ? "upcoming" : "held"}</span>
                      </div>
                      <div className="metric-value">{num(x.registrants)}<span className="unit"> registrants{state !== "held" ? " so far" : ""}</span></div>
                      {w.compare && ago && (() => {
                        const ref = cmp === "final" ? ago.registrants : (lastWeekAsOf.bySession.find((y) => +y.session_at === +ago.session_at)?.registrants ?? 0);
                        return <Delta cur={x.registrants} prev={ref} kind="count"
                          label={cmp === "final" ? `vs ${num(ref)} final for ${shortDate(ago.session_at)}` : `vs ${num(ref)} for ${shortDate(ago.session_at)} at this point last week`} />;
                      })()}
                      <div className="metric-sub">
                        {!adOn ? <span className="pill">Cost per registrant: connect Meta Ads</span>
                          : !spendComplete(x.reg_rows, x.covered_rows) ? incomplete
                          : <span><b className="strong">{usd(div(x.ad_spend, x.registrants), 2)}</b> per registrant · {usd(x.ad_spend)} spend</span>}
                        {adOn && w.compare && ago && spendComplete(x.reg_rows, x.covered_rows) && spendComplete(ago.reg_rows, ago.covered_rows) &&
                          <Delta cur={div(x.ad_spend, x.registrants)} prev={div(ago.ad_spend, ago.registrants)} kind="count" better="down" label="cost per registrant" />}
                      </div>
                    </div>
                  );
                })}
                <div className="card metric total" title="Unique people registered for any of this week's webinars: someone in both counts once, so this can be less than the cards added up.">
                  <div className="metric-head"><span className="tag">2</span><span className="metric-title">{w.label} total</span></div>
                  <div className="metric-value">{num(w.people)}<span className="unit"> registrants</span></div>
                  {w.compare && (() => {
                    const ref = cmp === "final" ? lastWeekPeople : lastWeekAsOf.total;
                    return <Delta cur={w.people} prev={ref} kind="count" label={cmp === "final" ? `vs ${num(ref)} last week (final)` : `vs ${num(ref)} last week at this point`} />;
                  })()}
                  <div className="metric-sub">
                    {!adOn ? <span className="pill">Cost per registrant: connect Meta Ads</span>
                      : !weekComplete ? incomplete
                      : <span><b className="strong">{usd(div(spend, w.people), 2)}</b> per registrant · {usd(spend)} spend</span>}
                    {adOn && w.compare && weekComplete && lastWeekComplete &&
                      <Delta cur={div(spend, w.people)} prev={div(lastSpend, lastWeekPeople)} kind="count" better="down" label="cost per registrant" />}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <section>
        <h2>Webinar <span className="muted small">· {held.length} session{held.length === 1 ? "" : "s"} held · {periodLabel}</span></h2>
        <div className="grid g3">
          <Card n={4} title="Attendance rate" value={pct(attendees, regsWithAtt)}
            sub={`${num(attendees)} of ${num(regsWithAtt)} registrants${attFromTracker ? " · show-ups from the team's tracker sheet" : ""}`}
            help="People who showed up ÷ people registered for that webinar. From Zoom when connected, otherwise the show-ups the team enters in the tracker sheet."
            state={withAtt.length ? {} : { needs: "Zoom" }}
            delta={<Delta cur={cur.attendance} prev={prev.attendance} kind="rate" label={vsLabel} />} />
          <Card n={5} title={`Stayed to pitch`} value={pct(sum(withZoom, "stayed_to_pitch"), zoomAttendees)}
            sub={`still on at ${PITCH_MINUTE} min`}
            help={`Attendees still in the webinar ${PITCH_MINUTE} minutes after it started ÷ attendees.`} state={needZoom}
            delta={<Delta cur={cur.stayed} prev={prev.stayed} kind="rate" label={vsLabel} />} />
          <Card n={6} title="Buyers from webinar" value={num(sum(held, "buyers"))}
            sub={`of ${num(regsHeld)} registrations`}
            help="People who bought on Whop after registering for one of these sessions."
            delta={<Delta cur={cur.buyers} prev={prev.buyers} kind="count" label={vsLabel} />} />
          <Card n={7} title="$ from webinar" value={usd(sum(held, "cash"))}
            sub="cash collected, net of refunds"
            help="Whop cash from buyers attributed to these sessions."
            delta={<Delta cur={cur.cash} prev={prev.cash} kind="count" label={vsLabel} />} />
          <div className="card metric" title="The $97 lead magnet sold on the webinar, as the team records it in the tracker sheet (it is processed in an account this dashboard cannot reach). Not included in $ from webinar.">
            <div className="metric-head"><span className="metric-title">$97 lead-magnet sales</span></div>
            <div className="metric-value">{usd(cur.lmCash)}</div>
            <Delta cur={cur.lmCash} prev={prev.lmCash} kind="count" label={vsLabel} />
            <div className="metric-sub">{num(sum(held, "lm_purchases"))} sales · from the team&apos;s tracker sheet</div>
          </div>
          <Card n={8} title="Attendee → buyer" value={pct(sum(withZoom, "attendee_buyers"), zoomAttendees)}
            sub="webinar conversion rate"
            help="Attendees who bought ÷ attendees." state={needZoom}
            delta={<Delta cur={cur.attBuyer} prev={prev.attBuyer} kind="rate" label={vsLabel} />} />
        </div>
      </section>

      <section>
        <h2>Onboarding calls <span className="muted small">· Leap Welcome Calls · {periodLabel}</span></h2>
        <div className="grid g4">
          <Card n={9} title="Calls attended" value={num(funnel.onb_attended)}
            sub={`of ${num(funnel.onb_booked)} booked`}
            help="Onboarding calls where the person showed up (GHL 'showed' mark, or the Zoom report once connected)."
            state={onbWarn} delta={<Delta cur={cur.onbAttended} prev={prev.onbAttended} kind="count" label={vsLabel} />} />
          <Card n={10} title="Show rate" value={onbKnown > 0 ? pct(funnel.onb_attended, onbKnown) : "—"}
            sub={onbKnown > 0 ? `of ${num(onbKnown)} calls with a known result` : "no results recorded yet"}
            help="Attended ÷ booked calls whose result is known."
            state={onbKnown < funnel.onb_unknown
              ? { warn: `Unreliable: only ${num(onbKnown)} of ${num(funnel.onb_booked)} calls have a result${zoomOn ? "" : " until Zoom is connected"}` }
              : onbWarn}
            delta={<Delta cur={cur.showRate} prev={prev.showRate} kind="rate" label={vsLabel} />} />
          <Card n={11} title="High-ticket buyers from calls" value={num(funnel.ht_after_onb_attended)}
            sub={`of ${num(funnel.ht_buyers)} high-ticket buyers`}
            help="Ignite or Mastermind buyers in the period who attended an onboarding call before paying."
            delta={<Delta cur={cur.htFromCalls} prev={prev.htFromCalls} kind="count" label={vsLabel} />} />
          <Card n={12} title="Call → high-ticket %" value={pct(funnel.ht_after_onb_attended, funnel.onb_attended)}
            sub="of attended calls"
            help="High-ticket buyers who attended a call ÷ calls attended."
            delta={<Delta cur={cur.callToHt} prev={prev.callToHt} kind="rate" label={vsLabel} />} />
        </div>
      </section>

      <section>
        <h2>Cash <span className="muted small">· {periodLabel}</span></h2>
        <div className="grid g4">
          <Card n={13} title="High-ticket cash collected" value={usd(funnel.ht_cash)}
            sub={`Ignite + Mastermind · all Whop ${usd(totals.cash_all)}`}
            help="Whop cash for Ignite and Mastermind offers, net of refunds, by payment date."
            delta={<Delta cur={cur.htCash} prev={prev.htCash} kind="count" label={vsLabel} />} />
          <Card n={14} title="Paid in full" value={pct(funnel.ht_pif, funnel.ht_purchases)}
            sub={`${num(funnel.ht_pif)} PIF · ${num(funnel.ht_financing)} financing · ${num(funnel.ht_plan)} plan`}
            help="High-ticket purchases paid in full (card/PayPal within 7 days) ÷ all high-ticket purchases."
            delta={<Delta cur={cur.pif} prev={prev.pif} kind="rate" label={vsLabel} />} />
          <div className="card metric" title="Whop checkouts that failed or were abandoned. Each person counts once.">
            <div className="metric-head"><span className="metric-title">Failed / abandoned checkouts</span></div>
            <div className="metric-value">{num(totals.failed.people)}</div>
            <Delta cur={cur.failed} prev={prev.failed} kind="count" better="down" label={vsLabel} />
            <div className="metric-sub">{usd(totals.failed.attempted_usd)} attempted · {num(totals.failed.recovered_people)} paid later</div>
          </div>
          <div className="card metric">
            <div className="metric-head"><span className="metric-title">Offer mix</span></div>
            <table className="mini">
              <tbody>
                {totals.by_group.length === 0 && <tr><td className="muted">No purchases</td></tr>}
                {totals.by_group.map((g) => (
                  <tr key={`${g.product_group}-${g.payment_type}`}>
                    <td>{GROUP_LABEL[g.product_group] ?? g.product_group} · {TYPE_LABEL[g.payment_type] ?? g.payment_type}</td>
                    <td>{num(g.purchases)}</td>
                    <td>{usd(g.cash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {upcoming.length > 0 && (
        <p className="small muted" style={{ marginTop: 20 }}>
          Upcoming: {upcoming.map((s) => `${sessionLabel(s.session_at)} (${num(s.registrants)} registered)`).join(" · ")}
        </p>
      )}

      <details className="more">
        <summary>Session-by-session breakdown</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th><th>Registrants</th><th>Spend</th><th>Cost/reg</th><th>Attended</th><th>Stayed</th>
                <th>Buyers</th><th>Cash</th><th>$97 sales</th><th>Onboarding attended</th><th>HT cash</th><th>PIF</th>
              </tr>
            </thead>
            <tbody>
              {held.length === 0 && <tr><td colSpan={12} className="muted">No sessions in this range.</td></tr>}
              {held.map((s) => (
                <tr key={s.session_at.toISOString()}>
                  <td>{sessionLabel(s.session_at)}</td>
                  <td>{num(s.registrants)}</td>
                  <td>{adOn && spendComplete(s.reg_rows, s.covered_rows) ? usd(s.ad_spend) : <span className="muted" title="ad spend missing for some sign-up days">—</span>}</td>
                  <td>{adOn && spendComplete(s.reg_rows, s.covered_rows) ? usd(div(s.ad_spend, s.registrants), 2) : <span className="muted" title="ad spend missing for some sign-up days">—</span>}</td>
                  <td>{s.attendees === null ? "—" : `${num(s.attendees)} · ${pct(s.attendees, s.registrants)}`}</td>
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
        <p className="small muted">Spend per session is an estimate: each day&apos;s spend is split across sessions by that day&apos;s registrations.</p>
      </details>

      <details className="more">
        <summary>How each number is calculated</summary>
        <ul className="defs">
          <li><b>Webinar numbers (4–8)</b> cover sessions held in the selected window. A purchase belongs to the most recent session the buyer registered for before paying (matched by email).</li>
          <li><b>Onboarding (9–12)</b> = Leap Welcome Calls, including reschedules. Attended = marked &quot;showed&quot; in GHL, otherwise taken from the call&apos;s Zoom report once Zoom is connected.</li>
          <li><b>High ticket</b> = Ignite and Mastermind offers. <b>Cash</b> = Whop payments net of refunds; failed checkouts never count.</li>
          <li><b>Paid in full</b> = card/PayPal, all within 7 days of the first payment (deposit + balance counts). <b>Financing</b> = any part through Sezzle, Klarna, Afterpay, ClarityPay or Splitit. <b>Plan</b> = Whop splits it in-house.</li>
          <li><b>Attendance</b> = people who showed up ÷ people registered. From Zoom once connected; until then the show-ups the team enters in its tracker sheet. <b>Stayed to pitch</b> = still in the Zoom webinar {PITCH_MINUTE} minutes after it started (Zoom only).</li>
          <li><b>Ad spend</b> = Facebook spend on the webinar campaigns: from Meta once connected, until then the tracker sheet's FB Stats (Standout campaigns). <b>$97 lead-magnet sales</b> come from the tracker sheet and are not part of $ from webinar.</li>
        </ul>
      </details>

      <details className="more">
        <summary>Sync status</summary>
        <div className="small" style={{ padding: "8px 2px" }}>
          {sync ? <div className="muted">Last run {dateTime(sync.started_at)}</div> : <div className="muted">No sync yet.</div>}
          {Object.entries(sync?.detail ?? {}).map(([k, v]) => (
            <div key={k}>
              <b>{k}</b>: {v.skipped ? `not connected` : v.ok ? "ok" : <span style={{ color: "var(--bad)" }}>{v.error}</span>}
            </div>
          ))}
        </div>
      </details>
    </main>
  );
}
