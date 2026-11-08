import { redirect } from "next/navigation";
import { hasSession } from "@/lib/guard";
import { env } from "@/lib/env";
import { lastSync, periodTotals, sessionMetrics, PITCH_MINUTE, type SessionRow } from "@/lib/metrics";
import { GROUP_LABEL, TYPE_LABEL, dateTime, div, num, pct, sessionLabel, usd } from "@/lib/format";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RANGES = [30, 60, 90, 180] as const;
const DAY = 86_400_000;

function Kpi({ n, label, value, sub }: { n?: number; label: string; value: string; sub?: string }) {
  return (
    <div className="card kpi">
      <div className="label">{n !== undefined && <span className="tag">{n}</span>}{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

const Na = ({ why }: { why: string }) => <span className="na" title={why}>—</span>;

function sum<K extends keyof SessionRow>(rows: SessionRow[], k: K): number {
  return rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ days?: string; synced?: string }> }) {
  if (!(await hasSession())) redirect("/login");
  const sp = await searchParams;
  const days = RANGES.includes(Number(sp.days) as (typeof RANGES)[number]) ? Number(sp.days) : 60;
  const now = new Date();
  const from = new Date(now.getTime() - days * DAY);
  // Sessions up to two weeks out are shown so upcoming registration counts are visible.
  const sessionsTo = new Date(now.getTime() + 14 * DAY);

  const [totals, sessions, sync] = await Promise.all([periodTotals(from, now), sessionMetrics(from, sessionsTo), lastSync()]);

  const sources = [
    { name: "HighLevel", on: !!env.ghl(), need: "GHL_PIT, GHL_LOCATION", key: "ghl_registrations" },
    { name: "Whop", on: !!env.whop(), need: "WHOP_API_KEY", key: "whop_payments" },
    { name: "Meta Ads", on: !!env.meta(), need: "META_ACCESS_TOKEN, META_AD_ACCOUNT_ID", key: "meta_ads" },
    { name: "Zoom", on: !!env.zoom(), need: "ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET", key: "zoom" },
    { name: "Slack report", on: !!env.slackWebhookUrl(), need: "SLACK_WEBHOOK_URL", key: "" },
  ];
  const metaOn = !!env.meta();
  const zoomOn = !!env.zoom();
  const past = sessions.filter((s) => s.session_at <= now);
  const zoomRows = past.filter((s) => s.attendees !== null);

  return (
    <main>
      <div className="row spread">
        <div className="row">
          <h1>TRC Dashboard</h1>
          <span className="seg row" style={{ gap: 0 }}>
            {RANGES.map((r) => (
              <a key={r} href={`/?days=${r}`} className={r === days ? "active" : ""}>{r}d</a>
            ))}
          </span>
        </div>
        <div className="row">
          <span className="small muted">
            {sync ? `Last sync ${dateTime(sync.started_at)}${sync.ok === false ? " (errors)" : sync.finished_at ? "" : " (running)"}` : "Never synced"}
          </span>
          <form method="post" action="/api/sync"><button className="primary" type="submit">Sync now</button></form>
          <form method="post" action="/api/logout"><button type="submit">Log out</button></form>
        </div>
      </div>

      {sp.synced === "error" && <div className="notice err">The sync finished with errors. Details are below under Data sources.</div>}

      <div className="row" style={{ marginTop: 14 }}>
        {sources.map((s) => {
          const r = s.key ? sync?.detail?.[s.key] : undefined;
          const err = r && !r.ok;
          return (
            <span key={s.name} className="chip" title={s.on ? (err ? r?.error : "Connected") : `Add ${s.need} in Vercel`}>
              <span className={`dot ${err ? "err" : s.on ? "on" : "off"}`} />
              {s.name}{!s.on && <span className="muted">· not connected</span>}{err && <span className="muted">· error</span>}
            </span>
          );
        })}
      </div>

      <h2>Last {days} days</h2>
      <div className="kpis">
        <Kpi n={1} label="Ad spend" value={metaOn ? usd(totals.ad_spend) : "—"} sub={metaOn ? undefined : "Needs Meta"} />
        <Kpi n={2} label="Cost per registrant" value={metaOn ? usd(div(totals.ad_spend, totals.registrants), 2) : "—"} sub={`${num(totals.registrants)} registrants`} />
        <Kpi n={3} label="Registration rate" value={metaOn ? pct(totals.registrants, totals.landing_page_views) : "—"} sub={metaOn ? `${num(totals.landing_page_views)} landing page views` : "Needs Meta"} />
        <Kpi n={4} label="Webinar attendance" value={zoomOn ? pct(sum(zoomRows, "attendees"), sum(zoomRows, "registrants")) : "—"} sub={zoomOn ? `${zoomRows.length} sessions with Zoom data` : "Needs Zoom"} />
        <Kpi n={5} label={`Stayed to pitch (${PITCH_MINUTE}+ min)`} value={zoomOn ? pct(sum(zoomRows, "stayed_to_pitch"), sum(zoomRows, "attendees")) : "—"} sub={zoomOn ? "of attendees" : "Needs Zoom"} />
        <Kpi label="Cash collected (all Whop)" value={usd(totals.cash_all)} sub={`${usd(totals.cash_webinar)} from webinar registrants`} />
        <Kpi label="Failed / abandoned checkouts" value={num(totals.failed.people)} sub={`${usd(totals.failed.attempted_usd)} attempted · ${num(totals.failed.recovered_people)} paid later`} />
      </div>

      <h2>By webinar session</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Registrants</th>
              <th><span className="tag">1</span>Spend</th>
              <th><span className="tag">2</span>Cost/reg</th>
              <th><span className="tag">3</span>Reg rate</th>
              <th><span className="tag">4</span>Attended</th>
              <th><span className="tag">5</span>Stayed to pitch</th>
              <th><span className="tag">6</span>Buyers</th>
              <th><span className="tag">7</span>Cash</th>
              <th><span className="tag">8</span>Attendee → buyer</th>
              <th><span className="tag">9</span>Onboarding attended</th>
              <th><span className="tag">10</span>Onboarding %</th>
              <th><span className="tag">11</span>HT buyers on onboarding</th>
              <th><span className="tag">12</span>HT on onboarding %</th>
              <th><span className="tag">13</span>HT cash</th>
              <th><span className="tag">14</span>PIF %</th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 && (
              <tr><td colSpan={16} className="muted" style={{ textAlign: "center" }}>No sessions in this range yet. Run a sync.</td></tr>
            )}
            {sessions.map((s) => {
              const upcoming = s.session_at > now;
              const known = s.onb_past - s.onb_unknown;
              return (
                <tr key={s.session_at.toISOString()}>
                  <td>{sessionLabel(s.session_at)}{upcoming && <span className="muted small"> · upcoming</span>}</td>
                  <td>{num(s.registrants)}</td>
                  <td>{metaOn ? usd(s.ad_spend) : <Na why="Needs Meta" />}</td>
                  <td>{metaOn ? usd(div(s.ad_spend, s.registrants), 2) : <Na why="Needs Meta" />}</td>
                  <td>{metaOn ? pct(s.registrants, s.landing_page_views) : <Na why="Needs Meta" />}</td>
                  <td>{s.attendees === null ? <Na why={zoomOn ? "No Zoom match yet" : "Needs Zoom"} /> : `${num(s.attendees)} · ${pct(s.attendees, s.registrants)}`}</td>
                  <td>{s.stayed_to_pitch === null ? <Na why="Needs Zoom" /> : `${num(s.stayed_to_pitch)} · ${pct(s.stayed_to_pitch, s.attendees)}`}</td>
                  <td>{num(s.buyers)}</td>
                  <td>{usd(s.cash)}</td>
                  <td>{s.attendee_buyers === null ? <Na why="Needs Zoom" /> : pct(s.attendee_buyers, s.attendees)}</td>
                  <td title={`${s.onb_booked} booked · ${s.onb_unknown} past calls with no attendance recorded`}>
                    {num(s.onb_attended)} <span className="muted small">/ {num(s.onb_booked)} booked</span>
                  </td>
                  <td>{known > 0 ? pct(s.onb_attended, known) : <Na why="No attendance recorded yet" />}</td>
                  <td title={`${s.ht_after_onb_booked} bought after booking an onboarding call`}>{num(s.ht_after_onb_attended)}</td>
                  <td>{s.onb_attended ? pct(s.ht_after_onb_attended, s.onb_attended) : <Na why="No attended onboarding calls" />}</td>
                  <td>{usd(s.ht_cash)}</td>
                  <td title={`${s.ht_pif} PIF · ${s.ht_financing} third-party financing · ${s.ht_plan} payment plan`}>{pct(s.ht_pif, s.ht_purchases)}</td>
                </tr>
              );
            })}
          </tbody>
          {past.length > 0 && (
            <tfoot>
              <tr>
                <td>Past sessions</td>
                <td>{num(sum(past, "registrants"))}</td>
                <td>{metaOn ? usd(sum(past, "ad_spend")) : <Na why="Needs Meta" />}</td>
                <td>{metaOn ? usd(div(sum(past, "ad_spend"), sum(past, "registrants")), 2) : <Na why="Needs Meta" />}</td>
                <td>{metaOn ? pct(sum(past, "registrants"), sum(past, "landing_page_views")) : <Na why="Needs Meta" />}</td>
                <td>{zoomRows.length ? pct(sum(zoomRows, "attendees"), sum(zoomRows, "registrants")) : <Na why="Needs Zoom" />}</td>
                <td>{zoomRows.length ? pct(sum(zoomRows, "stayed_to_pitch"), sum(zoomRows, "attendees")) : <Na why="Needs Zoom" />}</td>
                <td>{num(sum(past, "buyers"))}</td>
                <td>{usd(sum(past, "cash"))}</td>
                <td>{zoomRows.length ? pct(sum(zoomRows, "attendee_buyers"), sum(zoomRows, "attendees")) : <Na why="Needs Zoom" />}</td>
                <td>{num(sum(past, "onb_attended"))} <span className="muted small">/ {num(sum(past, "onb_booked"))}</span></td>
                <td>{(() => { const k = sum(past, "onb_past") - sum(past, "onb_unknown"); return k > 0 ? pct(sum(past, "onb_attended"), k) : <Na why="No attendance recorded yet" />; })()}</td>
                <td>{num(sum(past, "ht_after_onb_attended"))}</td>
                <td>{sum(past, "onb_attended") ? pct(sum(past, "ht_after_onb_attended"), sum(past, "onb_attended")) : <Na why="No attended onboarding calls" />}</td>
                <td>{usd(sum(past, "ht_cash"))}</td>
                <td>{pct(sum(past, "ht_pif"), sum(past, "ht_purchases"))}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <h2>Purchases by offer and payment type <span className="muted small">(first payment in the last {days} days, all buyers)</span></h2>
      <div className="table-wrap" style={{ maxWidth: 640 }}>
        <table>
          <thead><tr><th>Offer</th><th>Payment type</th><th>Purchases</th><th>Cash</th></tr></thead>
          <tbody>
            {totals.by_group.length === 0 && <tr><td colSpan={4} className="muted">No purchases in this range.</td></tr>}
            {totals.by_group.map((g) => (
              <tr key={`${g.product_group}-${g.payment_type}`}>
                <td>{GROUP_LABEL[g.product_group] ?? g.product_group}</td>
                <td>{TYPE_LABEL[g.payment_type] ?? g.payment_type}</td>
                <td>{num(g.purchases)}</td>
                <td>{usd(g.cash)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>How the numbers are calculated</h2>
      <div className="card">
        <ul className="defs">
          <li><b>Session:</b> the webinar date and time a person picked on the GHL registration form. Someone who registers twice counts in both sessions.</li>
          <li><b>Attribution:</b> a purchase or onboarding call belongs to the most recent session the person registered for <i>before</i> it happened. Matched by email between GHL and Whop.</li>
          <li><b>Spend per session:</b> each day&apos;s Meta spend is split across sessions by that day&apos;s registrations. The KPI cards above use unsplit totals.</li>
          <li><b>Attended / stayed to pitch:</b> from the Zoom participant report. &quot;Stayed&quot; means still in the room {PITCH_MINUTE} minutes after the start.</li>
          <li><b>Onboarding call:</b> Leap Welcome Calls (incl. reschedules). Attended = marked &quot;showed&quot; in GHL, otherwise taken from the Zoom report of that call. % uses past calls with a known result.</li>
          <li><b>High ticket (HT):</b> Ignite and Mastermind offers. <b>HT buyers on onboarding:</b> bought after attending an onboarding call.</li>
          <li><b>PIF:</b> paid in full on card/PayPal within 7 days of the first payment (a deposit + balance counts). <b>Third-party financing:</b> any part via Sezzle, Klarna, Afterpay, ClarityPay or Splitit. <b>Payment plan:</b> Whop splits it in-house.</li>
          <li><b>Cash:</b> Whop payments, net of refunds. Failed or abandoned checkouts are never counted as cash.</li>
        </ul>
      </div>

      {sync?.detail && (
        <>
          <h2>Data sources</h2>
          <div className="card small">
            {Object.entries(sync.detail).map(([k, v]) => (
              <div key={k}>
                <b>{k}</b>: {v.skipped ? `skipped (${v.skipped})` : v.ok ? "ok" : <span style={{ color: "var(--bad)" }}>{v.error}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
