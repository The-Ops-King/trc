// The sales tracker (Tyler and James, 2026-11-20). One row per call slot, from the GHL "TRC Sales Call" records the engine writes;
// the appointment only says the call was booked (TRC never marks showed or no-show on GHL appointments). Pure functions: the page
// loads rows, this file decides what each call was and every number, so the rules are tested in one place (sales-tracker.test.ts).
//
// Rules (Tyler, 2026-11-20):
// - Nick's calls only. A record for any other closer (Tiffany) is left out of every number.
// - One call per slot. A slot the engine marked "rescheduled" is not a call, unless something shows the call happened on it
//   (a recording, a call length, an objection, a disposition): then it is a call that showed and was moved afterwards.
// - Calls on calendar = showed + no-show + cancelled + not filed (past slots nobody filed). Cancels count (James's definition).
// - A blank is flagged, never counted as zero: a past call with no outcome is "not filed", not a no-show.
// - Close = closed_won only. Deposit and close pending are counted on their own.
// - Cash: the Sales Call's Cash Collected and Whop's paid payments, side by side; they should match, and every person where
//   they do not is listed.
// Toggles, where the data can be read two ways: shows from the Sales Call or from Zoom; filed only or filed plus evidence.
import type { ObjectRecord } from "./ghl.ts";

export const OUTCOMES = ["scheduled", "showed", "no_show", "cancelled", "rescheduled"] as const;
export const DISPOSITIONS = ["closed_won", "deposit", "close_pending", "follow_up", "lost", "financing_denied", "dq", "no_offer"] as const;
export const OBJECTIONS = ["price", "partner", "timing", "fear", "competitor", "think_about_it"] as const;
export const DISPOSITION_LABEL: Record<string, string> = {
  closed_won: "Closed won", deposit: "Deposit", close_pending: "Close pending", follow_up: "Follow-up", lost: "Lost",
  financing_denied: "Financing denied", dq: "Financial DQ", no_offer: "No offer (DQ before the pitch)",
};
export const OBJECTION_LABEL: Record<string, string> = {
  price: "Price", partner: "Partner / spouse", timing: "Timing", fear: "Fear", competitor: "Competitor", think_about_it: "Think about it",
};
/** Dispositions that mean an offer was made, when the Pitched field is blank. */
const OFFER_DISPOSITIONS = new Set(["closed_won", "deposit", "close_pending", "follow_up", "lost", "financing_denied"]);
const NO_OFFER_DISPOSITIONS = new Set(["dq", "no_offer"]);

export type SalesCallRow = {
  id: string; external_id: string; appointment_id: string; contact_id: string | null; slot_at: Date | null; closer: string | null;
  outcome: string | null; disposition: string | null; objection: string | null; call_type: string | null; package: string | null;
  pitched: string | null; cash_collected: number | null; contract_value: number | null; payment_terms: string | null;
  recording_url: string | null; duration_min: number | null; next_step_date: string | null; created_at: Date | null; updated_at: Date | null;
};

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? text(v[0]) : null;
  const s = String(v).trim();
  return s ? s : null;
};
/** GHL money fields come as {currency, value}; numbers as numbers or strings. Null when blank (never 0 for blank). */
const money = (v: unknown): number | null => {
  const raw = v && typeof v === "object" && !Array.isArray(v) ? (v as { value?: unknown }).value : v;
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = Number(String(raw).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const date = (v: unknown): Date | null => { const s = text(v); if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };

/** One GHL record as a stored row. */
export function salesCallRow(r: ObjectRecord): SalesCallRow {
  const p = r.properties ?? {};
  const ext = text(p.external_id) ?? r.id;
  return {
    id: r.id, external_id: ext, appointment_id: ext.split("@")[0]!, contact_id: text(p.contact_id),
    slot_at: date(p.scheduled_at), closer: text(p.closer)?.toLowerCase() ?? null,
    outcome: text(p.outcome), disposition: text(p.disposition), objection: text(p.objection_primary), call_type: text(p.call_type),
    package: text(p.package), pitched: text(p.pitched)?.toLowerCase() ?? null,
    cash_collected: money(p.cash_collected), contract_value: money(p.contract_value), payment_terms: text(p.payment_terms),
    recording_url: text(p.recording_url), duration_min: money(p.duration_min), next_step_date: text(p.next_step_date)?.slice(0, 10) ?? null,
    created_at: date(r.createdAt), updated_at: date(r.updatedAt),
  };
}

export type Appt = { id: string; contact_id?: string | null; calendar_id: string; start_at: Date; host_user_id: string | null; zoom_attended: boolean | null; appointment_status: string | null };
export type Person = { contact_id: string; name: string | null; email: string | null };

export type Basis = "evidence" | "filed";
export type ShowSource = "salescall" | "zoom";
export type Status = "showed" | "no_show" | "cancelled" | "not_filed" | "moved" | "upcoming";
export type Flag =
  | "moved_after_call"        // marked rescheduled, but the call happened on this slot
  | "outcome_not_filed"       // no outcome, but a disposition / recording says the call happened
  | "not_filed"               // past call, nothing filed
  | "showed_no_disposition"   // showed, no disposition
  | "close_no_cash"           // closed won / deposit with no Cash Collected
  | "follow_up_no_date"       // disposition follow-up with no Next Step Date
  | "offer_unknown"           // showed, Pitched blank and the disposition does not say
  | "zoom_disagrees"          // Zoom attendance says the other thing
  | "off_calendar"            // the appointment is not on a tracker calendar
  | "no_appointment";         // the appointment is not in the synced calendars (deleted, or a test/team booking)

export type Call = SalesCallRow & {
  status: Status; flags: Flag[]; followUp: boolean; offer: boolean | null; zoom: boolean | null; person: Person | null;
};

const MATCH_MS = 60 * 60_000;
const hasEvidence = (r: SalesCallRow) =>
  !!(r.recording_url || (r.duration_min ?? 0) > 0 || r.objection || r.disposition);

/**
 * What each of the tracker's Sales Calls was. `now` decides past and future; `basis` whether evidence counts when the outcome says
 * otherwise; `shows` whether showed / no-show come from the Sales Call or from Zoom (Zoom only where it saw the slot).
 */
export function classify(
  rows: SalesCallRow[], appts: Map<string, Appt>, people: Map<string, Person>,
  o: { now: Date; closers: ReadonlyArray<string>; calendars: ReadonlyArray<string>; basis: Basis; shows: ShowSource },
): Call[] {
  const mine = rows.filter((r) => r.closer && o.closers.includes(r.closer) && r.slot_at);
  const out: Call[] = mine.map((r) => {
    const flags: Flag[] = [];
    const past = r.slot_at!.getTime() <= o.now.getTime();
    const ev = hasEvidence(r);
    let status: Status;
    switch (r.outcome) {
      case "showed": status = "showed"; break;
      case "no_show": status = "no_show"; break;
      case "cancelled": status = "cancelled"; break;
      case "rescheduled":
        if (ev && o.basis === "evidence") { status = "showed"; flags.push("moved_after_call"); }
        else status = "moved";
        break;
      default:
        if (!past) status = "upcoming";
        else if (ev && o.basis === "evidence") { status = "showed"; flags.push("outcome_not_filed"); }
        else { status = "not_filed"; flags.push("not_filed"); }
    }
    // Zoom: only for the slot the appointment is at now (a moved appointment's Zoom match is for its new time).
    const a = appts.get(r.appointment_id);
    const sameSlot = a && Math.abs(a.start_at.getTime() - r.slot_at!.getTime()) <= MATCH_MS;
    const zoom = sameSlot ? a.zoom_attended : null;
    if (zoom !== null && (status === "showed" || status === "no_show") && (status === "showed") !== zoom) flags.push("zoom_disagrees");
    if (o.shows === "zoom" && zoom !== null && (status === "showed" || status === "no_show" || status === "not_filed")) {
      if (status === "not_filed") flags.splice(flags.indexOf("not_filed"), 1);
      status = zoom ? "showed" : "no_show";
    }
    if (!a) flags.push("no_appointment");
    else if (!o.calendars.includes(a.calendar_id)) flags.push("off_calendar");

    const offer = r.pitched === "yes" ? true : r.pitched === "no" ? false
      : r.disposition && OFFER_DISPOSITIONS.has(r.disposition) ? true : r.disposition && NO_OFFER_DISPOSITIONS.has(r.disposition) ? false : null;
    if (status === "showed") {
      if (!r.disposition) flags.push("showed_no_disposition");
      if (offer === null) flags.push("offer_unknown");
    }
    if ((r.disposition === "closed_won" || r.disposition === "deposit") && r.cash_collected === null) flags.push("close_no_cash");
    if (r.disposition === "follow_up" && !r.next_step_date) flags.push("follow_up_no_date");
    return { ...r, status, flags, followUp: false, offer, zoom, person: r.contact_id ? people.get(r.contact_id) ?? null : null };
  });
  // A follow-up call: marked one, or the person already had a call that showed with this closer before this slot.
  const byContact = new Map<string, Call[]>();
  for (const c of out) if (c.contact_id) byContact.set(c.contact_id, [...(byContact.get(c.contact_id) ?? []), c]);
  for (const c of out) {
    const earlier = (c.contact_id ? byContact.get(c.contact_id) ?? [] : []).some((x) => x !== c && x.status === "showed" && x.slot_at! < c.slot_at!);
    c.followUp = c.call_type === "follow_up" || earlier;
  }
  return out.sort((a, b) => a.slot_at!.getTime() - b.slot_at!.getTime());
}

/** Booked on a tracker calendar with a tracker closer as host, in the past, and the engine never made a Sales Call for it. */
export function bookingsWithoutRecord(appts: Appt[], rows: SalesCallRow[], o: { now: Date; calendars: ReadonlyArray<string>; hostIds: ReadonlyArray<string>; since: Date }): Appt[] {
  const have = new Set(rows.map((r) => r.appointment_id));
  return appts.filter((a) => o.calendars.includes(a.calendar_id) && a.host_user_id && o.hostIds.includes(a.host_user_id)
    && a.start_at >= o.since && a.start_at <= o.now && a.appointment_status !== "cancelled" && !have.has(a.id));
}

export type WhopPayment = { id: string; email: string; paid_at: Date; net_usd: number; product_title: string | null; method: string | null };

export type Numbers = {
  onCalendar: number; showed: number; noShow: number; cancelled: number; notFiled: number; moved: number; upcoming: number;
  people: number; firstCalls: number; followUps: number;
  showRate: number | null;            // shows ÷ (calls on calendar − not filed): a rate only over calls whose result is known
  offers: number; offerUnknown: number;
  closes: number; deposits: number; pending: number; followUpDisp: number; lost: number; financingDenied: number; dq: number; noOffer: number;
  closeRate: number | null;           // closes ÷ calls on calendar (James: every call on the calendar, not just shows)
  closeRateShows: number | null;      // closes ÷ shows
  cashSalesCall: number; contract: number; cashPerCall: number | null;
  objections: Record<string, number>; objectionBlank: number;
  packages: Record<string, number>;   // closes, deposits and pending by package; "" = not recorded
};

const COUNTED: ReadonlySet<Status> = new Set(["showed", "no_show", "cancelled", "not_filed"]);

/** Every number for the calls whose slot falls in [from, to). */
export function numbers(calls: Call[], from: Date, to: Date): Numbers {
  const inRange = calls.filter((c) => c.slot_at! >= from && c.slot_at! < to);
  const counted = inRange.filter((c) => COUNTED.has(c.status));
  const n = (s: Status) => inRange.filter((c) => c.status === s).length;
  const d = (k: string) => counted.filter((c) => c.disposition === k).length;
  const showed = n("showed"), notFiled = n("not_filed"), onCalendar = counted.length;
  const closes = d("closed_won");
  const objections: Record<string, number> = Object.fromEntries(OBJECTIONS.map((k) => [k, 0]));
  let objectionBlank = 0;
  for (const c of counted.filter((x) => x.status === "showed")) {
    if (c.objection) objections[c.objection] = (objections[c.objection] ?? 0) + 1;
    else if (c.disposition !== "closed_won") objectionBlank++;
  }
  const packages: Record<string, number> = {};
  for (const c of counted.filter((x) => x.disposition === "closed_won" || x.disposition === "deposit" || x.disposition === "close_pending")) {
    packages[c.package ?? ""] = (packages[c.package ?? ""] ?? 0) + 1;
  }
  const cash = counted.reduce((a, c) => a + (c.cash_collected ?? 0), 0);
  const known = onCalendar - notFiled;
  return {
    onCalendar, showed, noShow: n("no_show"), cancelled: n("cancelled"), notFiled, moved: n("moved"), upcoming: n("upcoming"),
    people: new Set(counted.map((c) => c.contact_id ?? c.id)).size,
    firstCalls: counted.filter((c) => !c.followUp).length, followUps: counted.filter((c) => c.followUp).length,
    showRate: known ? showed / known : null,
    offers: counted.filter((c) => c.offer === true).length, offerUnknown: counted.filter((c) => c.status === "showed" && c.offer === null).length,
    closes, deposits: d("deposit"), pending: d("close_pending"), followUpDisp: d("follow_up"), lost: d("lost"),
    financingDenied: d("financing_denied"), dq: d("dq"), noOffer: d("no_offer"),
    closeRate: onCalendar ? closes / onCalendar : null, closeRateShows: showed ? closes / showed : null,
    cashSalesCall: cash, contract: counted.reduce((a, c) => a + (c.contract_value ?? 0), 0), cashPerCall: onCalendar ? cash / onCalendar : null,
    objections, objectionBlank, packages,
  };
}

/**
 * Whop's paid payments that belong to the tracker: from a person with a tracker call, paid on or after the day of their first
 * call (the Leap purchase that got them on the calendar comes before it). Matched by email (the Sales Call's contact).
 */
export function trackerPayments(calls: Call[], payments: WhopPayment[], dayStart: (d: Date) => Date): Array<WhopPayment & { contact_id: string }> {
  const first = new Map<string, { at: Date; contact: string }>();
  for (const c of calls) {
    if (!COUNTED.has(c.status) || !c.person?.email || !c.contact_id) continue;
    const k = c.person.email.toLowerCase(), was = first.get(k);
    if (!was || c.slot_at! < was.at) first.set(k, { at: c.slot_at!, contact: c.contact_id });
  }
  return payments.flatMap((p) => {
    const f = first.get(p.email.toLowerCase());
    return f && p.paid_at >= dayStart(f.at) ? [{ ...p, contact_id: f.contact }] : [];
  });
}

/** Per person: Cash Collected on their Sales Calls against Whop's paid payments, all time. Only the ones that differ. */
export function cashMismatches(calls: Call[], pays: Array<WhopPayment & { contact_id: string }>) {
  const sc = new Map<string, number>(), wh = new Map<string, number>(), who = new Map<string, Person | null>();
  for (const c of calls) {
    if (!c.contact_id || !COUNTED.has(c.status)) continue;
    who.set(c.contact_id, c.person);
    if (c.cash_collected !== null) sc.set(c.contact_id, (sc.get(c.contact_id) ?? 0) + c.cash_collected);
  }
  for (const p of pays) wh.set(p.contact_id, (wh.get(p.contact_id) ?? 0) + p.net_usd);
  const ids = new Set([...sc.keys(), ...wh.keys()]);
  return [...ids].map((id) => ({ contact_id: id, person: who.get(id) ?? null, salesCall: sc.get(id) ?? 0, whop: wh.get(id) ?? 0 }))
    .filter((x) => Math.abs(x.salesCall - x.whop) >= 0.5);
}
