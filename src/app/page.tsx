import { redirect } from "next/navigation";
import { hasSession } from "@/lib/guard";
import { env } from "@/lib/env";
import {
  lastSuccessfulSync, lastSync, periodFunnel, periodTotals, registrantsByWebinarDay, sessionMetrics, PITCH_MINUTE, type SessionRow,
} from "@/lib/metrics";
import { GROUP_LABEL, TYPE_LABEL, dateTime, div, num, pct, sessionLabel, usd } from "@/lib/format";
import { laWallTimeToUtc } from "@/lib/session";
import { laDay, type PeriodFunnel, type PeriodTotals, type WebinarDayRow } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RANGES = [7, 30, 60, 90] as const;
const DAY = 86_400_000;
/** Show a warning when the last successful sync is older than this. */
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/** Give up well before Vercel's 60s limit, so a stalled database shows a message instead of a timeout page. */
const PAGE_DEADLINE_MS = 25_000;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms); }),
  ]);
}

/** Logs how long each query took (Vercel runtime logs), so the next slow load names its slow step. */
async function timed<T>(label: string, p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  try { return await p; }
  finally { const ms = Date.now() - t0; if (ms > 2000) console.warn(`[dashboard] slow query ${label}: ${ms}ms`); }
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
function figures(t: PeriodTotals, f: PeriodFunnel, held: SessionRow[], byDay: WebinarDayRow[]) {
  const row = (d: string) => byDay.find((r) => r.day === d) ?? { day: d, registrants: 0, ad_spend: 0 };
  const z = held.filter((s) => s.attendees !== null);
  const att = sum(z, "attendees");
  const known = f.onb_booked - f.onb_unknown;
  const rate = (a: number, b: number) => (b ? a / b : null);
  return {
    adSpend: t.ad_spend,
    regRate: rate(t.registrants, t.landing_page_views),
    regs: { tuesday: row("tuesday").registrants, thursday: row("thursday").registrants, other: row("other").registrants, total: row("total").registrants },
    cpr: {
      tuesday: rate(row("tuesday").ad_spend, row("tuesday").registrants), thursday: rate(row("thursday").ad_spend, row("thursday").registrants),
      other: rate(row("other").ad_spend, row("other").registrants), total: rate(row("total").ad_spend, row("total").registrants),
    },
    attendance: z.length ? rate(att, sum(z, "registrants")) : null,
    stayed: z.length ? rate(sum(z, "stayed_to_pitch"), att) : null,
    buyers: sum(held, "buyers"),
    cash: sum(held, "cash"),
    attBuyer: z.length ? rate(sum(z, "attendee_buyers"), att) : null,
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

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ days?: string; synced?: string }> }) {
  if (!(await hasSession())) redirect("/login");
  const sp = await searchParams;
  const days = RANGES.includes(Number(sp.days) as (typeof RANGES)[number]) ? Number(sp.days) : 30;
  const now = new Date();
  // Whole Pacific days: this period is the last `days` days including today; the previous period is the `days` days before it.
  const startOfLaDay = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number) as [number, number, number]; return laWallTimeToUtc(y, m - 1, d, 0, 0); };
  const shiftDays = (ymd: string, n: number) => new Date(Date.UTC(...(ymd.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number]) + n * DAY).toISOString().slice(0, 10);
  const today = laDay(now);
  const from = startOfLaDay(shiftDays(today, -(days - 1)));
  const prevFrom = startOfLaDay(shiftDays(today, -(2 * days - 1)));
  const vsLabel = `vs previous ${days} days`;

  let data;
  try {
    data = await withDeadline(Promise.all([
      timed("periodTotals", periodTotals(from, now)),
      timed("periodFunnel", periodFunnel(from, now)),
      timed("sessionMetrics", sessionMetrics(from, new Date(now.getTime() + 14 * DAY))),
      timed("lastSync", lastSync()),
      timed("lastSuccessfulSync", lastSuccessfulSync()),
      timed("registrantsByWebinarDay", registrantsByWebinarDay(from, now)),
      timed("prev.periodTotals", periodTotals(prevFrom, from)),
      timed("prev.periodFunnel", periodFunnel(prevFrom, from)),
      timed("prev.sessionMetrics", sessionMetrics(prevFrom, from)),
      timed("prev.registrantsByWebinarDay", registrantsByWebinarDay(prevFrom, from)),
    ]), PAGE_DEADLINE_MS);
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
  const [totals, funnel, sessions, sync, lastOk, byDay, pTotals, pFunnel, pSessions, pByDay] = data;
  const dayRow = (d: string) => byDay.find((r) => r.day === d) ?? { day: d, registrants: 0, ad_spend: 0 };
  const webinarDays = [
    { key: "tuesday", title: "Tuesday webinar", row: dayRow("tuesday") },
    { key: "thursday", title: "Thursday webinar", row: dayRow("thursday") },
    ...(dayRow("other").registrants ? [{ key: "other", title: "Other days", row: dayRow("other") }] : []),
    { key: "total", title: "Total (cost per registrant)", row: dayRow("total") },
  ];

  const metaOn = !!env.meta();
  const zoomOn = !!env.zoom();
  const needMeta: CardState = metaOn ? {} : { needs: "Meta Ads" };
  const needZoom: CardState = zoomOn ? {} : { needs: "Zoom" };

  // Webinar numbers (4-8) are per session: sessions held in the selected window.
  const held = sessions.filter((s) => s.session_at <= now);
  const cur = figures(totals, funnel, held, byDay);
  const prev = figures(pTotals, pFunnel, pSessions, pByDay);
  const upcoming = sessions.filter((s) => s.session_at > now).reverse();
  const withZoom = held.filter((s) => s.attendees !== null);
  const regsHeld = sum(held, "registrants");
  const attendees = sum(withZoom, "attendees");
  const regsWithZoom = sum(withZoom, "registrants");

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
              <a key={r} href={`/?days=${r}`} className={r === days ? "active" : ""}>{r === 7 ? "7 days" : `${r} days`}</a>
            ))}
          </nav>
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
        <h2>Ads <span className="muted small">· last {days} days</span></h2>
        <div className="grid g2">
          <Card n={1} title="Ad spend" value={usd(totals.ad_spend)} sub="Meta Ads, all webinar campaigns"
            help="Total Meta Ads spend in the selected period." state={needMeta}
            delta={<Delta cur={cur.adSpend} prev={prev.adSpend} kind="count" better="neither" label={vsLabel} />} />
          <Card n={3} title="Registration rate" value={pct(totals.registrants, totals.landing_page_views)}
            sub={`${num(totals.registrants)} registrants · ${num(totals.landing_page_views)} landing page views`}
            help="Registrants ÷ Meta landing page views." state={needMeta}
            delta={<Delta cur={cur.regRate} prev={prev.regRate} kind="rate" label={vsLabel} />} />
        </div>
        <div className={`grid ${webinarDays.length === 4 ? "g4" : "g3"}`} style={{ marginTop: 10 }}>
          {webinarDays.map(({ key, title, row }) => (
            <div key={key} className={`card metric${key === "total" ? " total" : ""}`}
              title="People who registered in the period for this webinar day (once per webinar day; the total counts a person once even if they registered for both). Cost per registrant: each day's Meta spend split across that day's registrations; the total uses all spend in the period.">
              <div className="metric-head"><span className="tag">2</span><span className="metric-title">{title}</span></div>
              <div className="metric-value">{num(row.registrants)}<span className="unit"> registrants</span></div>
              <Delta cur={cur.regs[key as keyof typeof cur.regs]} prev={prev.regs[key as keyof typeof prev.regs]} kind="count" label={vsLabel} />
              <div className="metric-sub">
                {metaOn ? <span><b className="strong">{usd(div(row.ad_spend, row.registrants), 2)}</b> per registrant · {usd(row.ad_spend)} spend</span> : <span className="pill">Cost per registrant: connect Meta Ads</span>}
                {metaOn && <Delta cur={cur.cpr[key as keyof typeof cur.cpr]} prev={prev.cpr[key as keyof typeof prev.cpr]} kind="count" better="down" label="cost per registrant" />}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Webinar <span className="muted small">· {held.length} session{held.length === 1 ? "" : "s"} held in the last {days} days</span></h2>
        <div className="grid g5">
          <Card n={4} title="Attendance rate" value={pct(attendees, regsWithZoom)}
            sub={`${num(attendees)} of ${num(regsWithZoom)} registrants`}
            help="People who joined the Zoom webinar ÷ people registered for that session." state={needZoom}
            delta={<Delta cur={cur.attendance} prev={prev.attendance} kind="rate" label={vsLabel} />} />
          <Card n={5} title={`Stayed to pitch`} value={pct(sum(withZoom, "stayed_to_pitch"), attendees)}
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
          <Card n={8} title="Attendee → buyer" value={pct(sum(withZoom, "attendee_buyers"), attendees)}
            sub="webinar conversion rate"
            help="Attendees who bought ÷ attendees." state={needZoom}
            delta={<Delta cur={cur.attBuyer} prev={prev.attBuyer} kind="rate" label={vsLabel} />} />
        </div>
      </section>

      <section>
        <h2>Onboarding calls <span className="muted small">· Leap Welcome Calls in the last {days} days</span></h2>
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
        <h2>Cash <span className="muted small">· last {days} days</span></h2>
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
                <th>Buyers</th><th>Cash</th><th>Onboarding attended</th><th>HT cash</th><th>PIF</th>
              </tr>
            </thead>
            <tbody>
              {held.length === 0 && <tr><td colSpan={11} className="muted">No sessions in this range.</td></tr>}
              {held.map((s) => (
                <tr key={s.session_at.toISOString()}>
                  <td>{sessionLabel(s.session_at)}</td>
                  <td>{num(s.registrants)}</td>
                  <td>{metaOn ? usd(s.ad_spend) : "—"}</td>
                  <td>{metaOn ? usd(div(s.ad_spend, s.registrants), 2) : "—"}</td>
                  <td>{s.attendees === null ? "—" : `${num(s.attendees)} · ${pct(s.attendees, s.registrants)}`}</td>
                  <td>{s.stayed_to_pitch === null ? "—" : pct(s.stayed_to_pitch, s.attendees)}</td>
                  <td>{num(s.buyers)}</td>
                  <td>{usd(s.cash)}</td>
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
          <li><b>Stayed to pitch</b> = still in the Zoom webinar {PITCH_MINUTE} minutes after it started.</li>
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
