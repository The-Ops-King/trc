import { redirect } from "next/navigation";
import { hasSession } from "@/lib/guard";
import { env } from "@/lib/env";
import { laWallTimeToUtc } from "@/lib/session";
import { dateTime, usd } from "@/lib/format";
import { SALES_TRACKER } from "@/lib/config";
import { loadSalesTracker } from "@/lib/sales-tracker-data";
import { cashMismatches, numbers, DISPOSITION_LABEL, OBJECTION_LABEL, OBJECTIONS, PACKAGE_LABEL, type Basis, type Call, type Flag, type ShowSource } from "@/lib/sales-tracker";
import { Card, Section } from "../ui";
import { Tabs } from "../tabs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAY = 86_400_000;
/** Give up well before Vercel's 60s limit, so a stalled database shows a message instead of a timeout page (as the webinar tab does). */
const PAGE_DEADLINE_MS = 25_000;
const TZ = "America/Los_Angeles";
const laYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const startOfLaDay = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number) as [number, number, number]; return laWallTimeToUtc(y, m - 1, d, 0, 0); };
const shiftDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const mondayOf = (ymd: string) => shiftDays(ymd, -((new Date(`${ymd}T12:00:00Z`).getUTCDay() + 6) % 7));
const shortDay = (ymd: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));
const slotText = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
const rate = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

const STATUS_LABEL: Record<string, string> = {
  showed: "Showed", no_show: "No-show", cancelled: "Cancelled", not_filed: "Not filed", moved: "Rescheduled (not a call)", upcoming: "Upcoming",
};
const FLAG_LABEL: Record<Flag, string> = {
  moved_after_call: "Marked rescheduled, but the call happened on this slot (recording, length or objection on it)",
  outcome_not_filed: "No outcome filed, but the record says the call happened (disposition, recording or objection)",
  not_filed: "Past call with nothing filed",
  showed_no_disposition: "Showed, no disposition",
  close_no_cash: "Closed won or deposit with no Cash Collected",
  follow_up_no_date: "Follow-up with no Next Step Date",
  offer_unknown: "Showed, and neither Pitched nor the disposition says whether an offer was made",
  zoom_disagrees: "Zoom says the opposite: a prospect joined a call marked no-show or rescheduled, or nobody joined one marked showed",
  off_calendar: "The booking is not on one of the tracker's calendars",
  no_appointment: "The booking is not in GHL's calendars any more (deleted or moved off them)",
};

type SP = { week?: string; all?: string; basis?: string; shows?: string };

export default async function SalesTracker({ searchParams }: { searchParams: Promise<SP> }) {
  if (!(await hasSession())) redirect("/login");
  const sp = await searchParams;
  const now = new Date();
  const today = laYmd(now);
  const basis: Basis = sp.basis === "filed" ? "filed" : "evidence";
  const shows: ShowSource = sp.shows === "zoom" ? "zoom" : "salescall";
  const all = sp.all === "1";
  const weekMon = /^\d{4}-\d{2}-\d{2}$/.test(sp.week ?? "") ? mondayOf(sp.week!) : mondayOf(today);
  const from = all ? new Date(0) : startOfLaDay(weekMon);
  const to = all ? new Date(8.64e15) : startOfLaDay(shiftDays(weekMon, 7));
  const link = (o: Partial<{ week: string; all: boolean; basis: Basis; shows: ShowSource }>) => {
    const q = new URLSearchParams();
    const isAll = o.all ?? (o.week ? false : all);
    const wk = o.week ?? weekMon;
    if (isAll) q.set("all", "1"); else if (wk !== mondayOf(today)) q.set("week", wk);
    if ((o.basis ?? basis) === "filed") q.set("basis", "filed");
    if ((o.shows ?? shows) === "zoom") q.set("shows", "zoom");
    const s = q.toString();
    return `/sales${s ? `?${s}` : ""}`;
  };

  let data;
  try {
    data = await Promise.race([
      loadSalesTracker({ now, basis, shows, dayStart: (d) => startOfLaDay(laYmd(d)) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${PAGE_DEADLINE_MS / 1000}s`)), PAGE_DEADLINE_MS)),
    ]);
  } catch (err) {
    console.error(`[sales] page data failed: ${err instanceof Error ? err.message : String(err)}`);
    return <main><Tabs active="sales" /><div className="notice err"><b>The sales tracker couldn&apos;t load.</b> The cause is in the Vercel logs under &quot;[sales]&quot;.</div></main>;
  }
  const { calls, pays, missing, zoomNoRecord, people, step, lastOk, recordCount } = data;
  const n = numbers(calls, from, to);
  const inRange = calls.filter((c) => c.slot_at! >= from && c.slot_at! < to);
  const whopInRange = pays.filter((p) => p.paid_at >= from && p.paid_at < to);
  const whopCash = whopInRange.reduce((a, p) => a + p.net_usd, 0);
  const mismatches = cashMismatches(calls, pays);
  const missingInRange = missing.filter((a) => a.start_at >= from && a.start_at < to);
  const zoomInRange = zoomNoRecord.filter((z) => z.start_at >= from && z.start_at < to);
  const flagged = inRange.filter((c) => c.flags.length);
  const flagCounts = new Map<Flag, number>();
  for (const c of inRange) for (const f of c.flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  const location = env.ghl()?.locationId ?? null;
  const contactUrl = (id: string | null) => (id && location ? `https://app.tiffanyrosecoaching.com/v2/location/${location}/contacts/detail/${id}` : null);
  const who = (c: { contact_id?: string | null; person?: { name: string | null } | null }) =>
    c.person?.name ?? (c.contact_id ? people.get(c.contact_id)?.name : null) ?? c.contact_id ?? "—";
  const periodLabel = all ? "all time" : `${shortDay(weekMon)} – ${shortDay(shiftDays(weekMon, 6))}`;
  const notFiledWarn = n.notFiled ? `${n.notFiled} call${n.notFiled === 1 ? "" : "s"} not filed` : undefined;
  const pkg = Object.entries(n.packages);

  return (
    <>
      <div className="bar">
        <div className="bar-inner">
          <div className="bar-top">
            <div className="brand">
              <img src="/logo.png" alt="Tiffany Rose Coaching" />
              <div><span className="eyebrow">Tiffany Rose Coaching</span><h1>Sales tracker</h1></div>
            </div>
            <div className="meta">
              <span>{lastOk ? `Updated ${dateTime(lastOk)}` : "Not synced yet"}</span>
              <form method="post" action="/api/sync"><button className="primary" type="submit">Sync now</button></form>
              <form method="post" action="/api/logout"><button type="submit">Log out</button></form>
            </div>
          </div>
          <Tabs active="sales" />
          <div className="bar-filters">
            <nav className="seg" aria-label="Week">
              <a href={link({ week: shiftDays(weekMon, -7) })}>← Week before</a>
              <a href={link({ week: mondayOf(today) })} className={!all && weekMon === mondayOf(today) ? "active" : ""}>This week</a>
              <a href={link({ week: shiftDays(weekMon, 7) })}>Week after →</a>
              <a href={link({ all: true })} className={all ? "active" : ""}>All time</a>
            </nav>
            <nav className="seg" aria-label="Shows from">
              <a href={link({ shows: "salescall" })} className={shows === "salescall" ? "active" : ""}>Shows: Sales Call</a>
              <a href={link({ shows: "zoom" })} className={shows === "zoom" ? "active" : ""}>Shows: Zoom</a>
            </nav>
            <nav className="seg" aria-label="Read the records">
              <a href={link({ basis: "evidence" })} className={basis === "evidence" ? "active" : ""}>Filed + evidence</a>
              <a href={link({ basis: "filed" })} className={basis === "filed" ? "active" : ""}>Filed only</a>
            </nav>
          </div>
          <p className="summary">Nick&apos;s calls, {periodLabel} (weeks run Monday to Sunday, Pacific). One call per slot, from GHL&apos;s TRC Sales Call records.</p>
        </div>
      </div>
      <main>
        {step && !step.ok && <div className="notice err"><b>The Sales Call sync failed:</b> {step.error}</div>}
        {!recordCount && <div className="notice err">No Sales Call records are stored yet. Press <b>Sync now</b>. If it fails, the GHL key needs the <code>objects/record.readonly</code> scope.</div>}

        <Section title="Calls" intro="Every call that was on the calendar this period. Cancels count. A past call nobody filed is counted as a call but not as a show or a no-show.">
          <div className="grid g4">
            <Card title="Calls on calendar" value={String(n.onCalendar)} big sub={`${n.people} people · ${n.firstCalls} first calls · ${n.followUps} follow-ups`}
              info={<>Showed + no-show + cancelled + not filed. Slots the engine marked rescheduled are not calls ({n.moved} this period), unless the call happened on them. Upcoming calls ({n.upcoming}) are not counted yet.</>} />
            <Card title="Shows" value={String(n.showed)} sub={`${n.noShow} no-shows · ${n.cancelled} cancelled`} warn={notFiledWarn} />
            <Card title="Show rate" value={rate(n.showRate)} warn={notFiledWarn}
              info={<>Shows ÷ calls on calendar, cancels included. Calls not filed are left out of this rate until they are filed, so a blank never counts as a no-show.</>} />
            <Card title="Not filed" value={String(n.notFiled)} sub="Past calls with no outcome on the Sales Call" warn={n.notFiled ? "Fix before the Friday report" : undefined} />
          </div>
        </Section>

        <Section title="Results">
          <div className="grid g4">
            <Card title="Closes" value={String(n.closes)} big sub={`${n.deposits} deposits · ${n.pending} close pending`} info={<>Closed won only. Deposits and close pending are counted on their own.</>} />
            <Card title="Close rate (calendar)" value={rate(n.closeRate)} info={<>Closes ÷ every call on the calendar, not just shows (James&apos;s definition).</>} />
            <Card title="Close rate (shows)" value={rate(n.closeRateShows)} info={<>Closes ÷ shows.</>} />
            <Card title="Offers made" value={String(n.offers)} warn={n.offerUnknown ? `${n.offerUnknown} shows unknown` : undefined}
              info={<>Pitched = yes, or a disposition that means an offer was made (closed, deposit, pending, follow-up, lost, financing denied) when Pitched is blank.</>} />
          </div>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Disposition</th><th>Calls</th></tr></thead>
              <tbody>
                {(["closed_won", "deposit", "close_pending", "follow_up", "lost", "financing_denied", "dq", "no_offer"] as const).map((k) => (
                  <tr key={k}><td>{DISPOSITION_LABEL[k]}</td><td>{({ closed_won: n.closes, deposit: n.deposits, close_pending: n.pending, follow_up: n.followUpDisp, lost: n.lost, financing_denied: n.financingDenied, dq: n.dq, no_offer: n.noOffer })[k]}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Cash" intro="Sales Call cash is counted on the call's date; Whop cash on the day it was paid (paid payments only). They should match person by person; every difference is listed below.">
          <div className="grid g4">
            <Card title="Cash collected (Sales Call)" value={usd(n.cashSalesCall)} big />
            <Card title="Cash collected (Whop)" value={usd(whopCash)} big warn={Math.abs(whopCash - n.cashSalesCall) >= 0.5 ? "Differs from the Sales Call" : undefined}
              info={<>Paid Whop payments from people with one of Nick&apos;s calls, paid on or after the day of their first call (the Leap purchase that booked them comes before). Failed, open and void attempts never count.</>} />
            <Card title="Cash per call on calendar" value={n.cashPerCall === null ? "—" : usd(n.cashPerCall)} info={<>Sales Call cash ÷ calls on calendar.</>} />
            <Card title="Contracted" value={usd(n.contract)} sub="Contract Value on the Sales Calls" />
          </div>
          {mismatches.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Cash differs (all time)</th><th>Sales Call</th><th>Whop</th></tr></thead>
                <tbody>{mismatches.map((m) => { const href = contactUrl(m.contact_id); return (
                  <tr key={m.contact_id}><td>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{who(m)}</a> : who(m)}</td><td>{usd(m.salesCall)}</td><td>{usd(m.whop)}</td></tr>); })}</tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Objections and packages" intro="A close, deposit or close pending with no Package on its Sales Call takes the package its person's Whop products say, marked (from Whop) in the call log.">
          <div className="grid g2">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Primary objection (shows)</th><th>Calls</th></tr></thead>
                <tbody>
                  {OBJECTIONS.map((k) => <tr key={k}><td>{OBJECTION_LABEL[k]}</td><td>{n.objections[k] ?? 0}</td></tr>)}
                  <tr><td className="muted">Not recorded (shows that did not close)</td><td>{n.objectionBlank}</td></tr>
                </tbody>
              </table>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Package (closes, deposits, pending)</th><th>Calls</th></tr></thead>
                <tbody>
                  {pkg.length ? pkg.map(([k, v]) => <tr key={k}><td className={k ? "" : "muted"}>{k ? PACKAGE_LABEL[k] ?? k : "Not recorded"}</td><td>{v}</td></tr>) : <tr><td className="muted">None this period</td><td>0</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </Section>

        <Section title="Data check" intro="Everything below needs fixing in GHL (or the EOD) before the numbers go to Tiffany. A blank is listed here, never counted as zero.">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Check</th><th>Calls</th></tr></thead>
              <tbody>
                {(Object.keys(FLAG_LABEL) as Flag[]).map((f) => <tr key={f}><td>{FLAG_LABEL[f]}</td><td>{flagCounts.get(f) ?? 0}</td></tr>)}
                <tr><td>Booked with Nick, past, and no Sales Call record</td><td>{missingInRange.length}</td></tr>
                <tr><td>Zoom saw a prospect on a call with no Sales Call for that time (a call nobody logged)</td><td>{zoomInRange.length}</td></tr>
              </tbody>
            </table>
          </div>
          {missingInRange.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Booked, no Sales Call</th><th>When</th><th>Calendar</th></tr></thead>
                <tbody>{missingInRange.map((a) => { const href = contactUrl(a.contact_id ?? null); const nm = (a.contact_id && people.get(a.contact_id)?.name) || a.contact_id || a.id; return (
                  <tr key={a.id}><td>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{nm}</a> : nm}</td><td>{slotText(a.start_at)}</td>
                    <td>{SALES_TRACKER.calendars.find((k) => k.id === a.calendar_id)?.name ?? a.calendar_id}</td></tr>); })}</tbody>
              </table>
            </div>
          )}
        </Section>

        {zoomInRange.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Zoom call, no Sales Call</th><th>When</th></tr></thead>
              <tbody>{zoomInRange.map((z) => { const a = data.calls.find((c) => c.appointment_id === z.appointment_id); return (
                <tr key={`${z.appointment_id}${z.start_at.toISOString()}`}><td>{a ? who(a) : z.appointment_id}</td><td>{slotText(z.start_at)}</td></tr>); })}</tbody>
            </table>
          </div>
        )}

        <Section title="Call log" intro={`Every slot this period, ${inRange.length} in all, flagged ones first.`}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Prospect</th><th>Slot</th><th>Counted as</th><th>Outcome in GHL</th><th>Disposition</th><th>Objection</th><th>Package</th><th>Cash</th><th>Zoom</th><th>Checks</th></tr></thead>
              <tbody>{[...flagged, ...inRange.filter((c) => !c.flags.length)].map((c: Call) => { const href = contactUrl(c.contact_id); return (
                <tr key={c.id}>
                  <td>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{who(c)}</a> : who(c)}{c.followUp ? <span className="muted"> · follow-up</span> : null}</td>
                  <td>{slotText(c.slot_at!)}</td>
                  <td>{STATUS_LABEL[c.status]}</td>
                  <td className="muted">{c.outcome ?? "blank"}</td>
                  <td>{c.disposition ? DISPOSITION_LABEL[c.disposition] ?? c.disposition : "—"}</td>
                  <td>{c.objection ? OBJECTION_LABEL[c.objection] ?? c.objection : "—"}</td>
                  <td>{c.package ? `${PACKAGE_LABEL[c.package] ?? c.package}${c.packageFrom === "whop" ? " (from Whop)" : ""}` : "—"}</td>
                  <td>{c.cash_collected === null ? "—" : usd(c.cash_collected)}</td>
                  <td>{c.zoom === null ? "—" : c.zoom ? "attended" : "absent"}</td>
                  <td style={{ whiteSpace: "normal", textAlign: "left", minWidth: 220 }} className="small">{c.flags.map((f) => FLAG_LABEL[f]).join("; ")}</td>
                </tr>); })}</tbody>
            </table>
          </div>
        </Section>

        <details className="more">
          <summary>How every number is counted</summary>
          <ul className="defs">
            <li><b>Calls</b>: GHL&apos;s TRC Sales Call records with closer Nick. Tiffany&apos;s calls are left out. Calendars: {SALES_TRACKER.calendars.map((k) => k.name).join(", ")}.</li>
            <li><b>One call per slot</b>: when a booking moves, the engine opens a record for the new slot and marks the old one rescheduled. A rescheduled slot is not a call, unless a recording, call length, objection or disposition is on it (then it showed and was moved afterwards). <b>Filed only</b> turns that off and reads every outcome as GHL has it.</li>
            <li><b>Zoom</b> is read per call: the meeting on the booking's link that started within an hour of the call's time. A prospect in it (not the team, not a note-taker bot) means the call happened, which counts as evidence like a recording; only the team or a bot in it means nobody came. No meeting seen says nothing. <b>Shows: Zoom</b> lets Zoom decide showed / no-show wherever it saw the call.</li>
            <li><b>Follow-up</b>: Call Type is follow-up, or the person already showed for an earlier call with Nick.</li>
            <li><b>Show rate</b> = shows ÷ (calls on calendar − not filed). <b>Close rate</b> = closed won ÷ calls on calendar; on shows = closed won ÷ shows. <b>Cash per call</b> = Sales Call cash ÷ calls on calendar.</li>
            <li><b>Test and team</b> bookings (team emails, test domains) are left out, as everywhere on the dashboard.</li>
          </ul>
        </details>
      </main>
    </>
  );
}
