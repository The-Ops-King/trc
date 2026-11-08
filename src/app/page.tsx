import { redirect } from "next/navigation";
import { hasSession } from "@/lib/guard";
import { env } from "@/lib/env";
import {
  lastSuccessfulSync, lastSync, periodFunnel, periodTotals, sessionMetrics, PITCH_MINUTE, type SessionRow,
} from "@/lib/metrics";
import { GROUP_LABEL, TYPE_LABEL, dateTime, div, num, pct, sessionLabel, usd } from "@/lib/format";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RANGES = [7, 30, 60, 90] as const;
const DAY = 86_400_000;
/** Show a warning when the last successful sync is older than this. */
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

type CardState = { needs?: string; warn?: string };

function Card({ n, title, value, sub, help, state = {} }: {
  n: number; title: string; value: string; sub?: string; help: string; state?: CardState;
}) {
  const blocked = !!state.needs;
  return (
    <div className={`card metric${blocked ? " blocked" : ""}`} title={help}>
      <div className="metric-head">
        <span className="tag">{n}</span>
        <span className="metric-title">{title}</span>
      </div>
      <div className="metric-value">{blocked ? "—" : value}</div>
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

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ days?: string; synced?: string }> }) {
  if (!(await hasSession())) redirect("/login");
  const sp = await searchParams;
  const days = RANGES.includes(Number(sp.days) as (typeof RANGES)[number]) ? Number(sp.days) : 30;
  const now = new Date();
  const from = new Date(now.getTime() - days * DAY);

  const [totals, funnel, sessions, sync, lastOk] = await Promise.all([
    periodTotals(from, now),
    periodFunnel(from, now),
    sessionMetrics(from, new Date(now.getTime() + 14 * DAY)),
    lastSync(),
    lastSuccessfulSync(),
  ]);

  const metaOn = !!env.meta();
  const zoomOn = !!env.zoom();
  const needMeta: CardState = metaOn ? {} : { needs: "Meta Ads" };
  const needZoom: CardState = zoomOn ? {} : { needs: "Zoom" };

  // Webinar numbers (4-8) are per session: sessions held in the selected window.
  const held = sessions.filter((s) => s.session_at <= now);
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
        <div className="grid g3">
          <Card n={1} title="Ad spend" value={usd(totals.ad_spend)} sub="Meta Ads, all webinar campaigns"
            help="Total Meta Ads spend in the selected period." state={needMeta} />
          <Card n={2} title="Cost per registrant" value={usd(div(totals.ad_spend, totals.registrants), 2)}
            sub={`${num(totals.registrants)} people registered`}
            help="Ad spend ÷ unique people who registered for a webinar in the period." state={needMeta} />
          <Card n={3} title="Registration rate" value={pct(totals.registrants, totals.landing_page_views)}
            sub={`${num(totals.landing_page_views)} landing page views`}
            help="Registrants ÷ Meta landing page views." state={needMeta} />
        </div>
      </section>

      <section>
        <h2>Webinar <span className="muted small">· {held.length} session{held.length === 1 ? "" : "s"} held in the last {days} days</span></h2>
        <div className="grid g5">
          <Card n={4} title="Attendance rate" value={pct(attendees, regsWithZoom)}
            sub={`${num(attendees)} of ${num(regsWithZoom)} registrants`}
            help="People who joined the Zoom webinar ÷ people registered for that session." state={needZoom} />
          <Card n={5} title={`Stayed to pitch`} value={pct(sum(withZoom, "stayed_to_pitch"), attendees)}
            sub={`still on at ${PITCH_MINUTE} min`}
            help={`Attendees still in the webinar ${PITCH_MINUTE} minutes after it started ÷ attendees.`} state={needZoom} />
          <Card n={6} title="Buyers from webinar" value={num(sum(held, "buyers"))}
            sub={`of ${num(regsHeld)} registrations`}
            help="People who bought on Whop after registering for one of these sessions." />
          <Card n={7} title="$ from webinar" value={usd(sum(held, "cash"))}
            sub="cash collected, net of refunds"
            help="Whop cash from buyers attributed to these sessions." />
          <Card n={8} title="Attendee → buyer" value={pct(sum(withZoom, "attendee_buyers"), attendees)}
            sub="webinar conversion rate"
            help="Attendees who bought ÷ attendees." state={needZoom} />
        </div>
      </section>

      <section>
        <h2>Onboarding calls <span className="muted small">· Leap Welcome Calls in the last {days} days</span></h2>
        <div className="grid g4">
          <Card n={9} title="Calls attended" value={num(funnel.onb_attended)}
            sub={`of ${num(funnel.onb_booked)} booked`}
            help="Onboarding calls where the person showed up (GHL 'showed' mark, or the Zoom report once connected)."
            state={onbWarn} />
          <Card n={10} title="Show rate" value={onbKnown > 0 ? pct(funnel.onb_attended, onbKnown) : "—"}
            sub={onbKnown > 0 ? `of ${num(onbKnown)} calls with a known result` : "no results recorded yet"}
            help="Attended ÷ booked calls whose result is known."
            state={onbKnown < funnel.onb_unknown
              ? { warn: `Unreliable: only ${num(onbKnown)} of ${num(funnel.onb_booked)} calls have a result${zoomOn ? "" : " until Zoom is connected"}` }
              : onbWarn} />
          <Card n={11} title="High-ticket buyers from calls" value={num(funnel.ht_after_onb_attended)}
            sub={`of ${num(funnel.ht_buyers)} high-ticket buyers`}
            help="Ignite or Mastermind buyers in the period who attended an onboarding call before paying." />
          <Card n={12} title="Call → high-ticket %" value={pct(funnel.ht_after_onb_attended, funnel.onb_attended)}
            sub="of attended calls"
            help="High-ticket buyers who attended a call ÷ calls attended." />
        </div>
      </section>

      <section>
        <h2>Cash <span className="muted small">· last {days} days</span></h2>
        <div className="grid g4">
          <Card n={13} title="High-ticket cash collected" value={usd(funnel.ht_cash)}
            sub={`Ignite + Mastermind · all Whop ${usd(totals.cash_all)}`}
            help="Whop cash for Ignite and Mastermind offers, net of refunds, by payment date." />
          <Card n={14} title="Paid in full" value={pct(funnel.ht_pif, funnel.ht_purchases)}
            sub={`${num(funnel.ht_pif)} PIF · ${num(funnel.ht_financing)} financing · ${num(funnel.ht_plan)} plan`}
            help="High-ticket purchases paid in full (card/PayPal within 7 days) ÷ all high-ticket purchases." />
          <div className="card metric" title="Whop checkouts that failed or were abandoned. Each person counts once.">
            <div className="metric-head"><span className="metric-title">Failed / abandoned checkouts</span></div>
            <div className="metric-value">{num(totals.failed.people)}</div>
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
