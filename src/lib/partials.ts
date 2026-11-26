// Partials (Tyler, 2026-11-13): a person who gave a name plus an email or phone (a webinar registration) and has never booked a
// call on any of TRC's GHL calendars. Cancelled or no-show still counts as booked. People, not contact records (people.ts).
// One dataset, read by the dashboard and by the partial-tag sync, so the logic lives in one place.
import { groupPeople, normEmail, normName, normPhone, type Contactish } from "./people.ts";

export type RegRecord = {
  submission_id: string; contact_id: string | null; email: string | null; full_name: string | null; phone: string | null;
  created_at: Date; session_at: Date | null; utm_source: string | null; utm_campaign: string | null; utm_content: string | null; utm_term: string | null;
};
export type ApptRecord = { id: string; contact_id: string | null; email: string | null; full_name: string | null; phone: string | null; start_at: Date };

export type FunnelPerson = {
  id: string;
  addedAt: Date;                 // when they first gave their contact (their first qualifying registration)
  contactId: string | null;      // their main contact: the form contact of that first registration
  contactIds: string[];          // every registration (form) contact of theirs
  booked: boolean;               // any appointment on any of their contacts, any status, any time
  campaign: string | null; adset: string | null; ad: string | null;   // the ad of that first registration
  sessionAt: Date | null;        // the webinar that first registration picked
  regs: Array<{ at: Date; sessionAt: Date | null; campaign: string | null; adset: string | null; ad: string | null; fromAd: boolean }>;   // every registration, oldest first
};

/** A UTM value still holding Meta's macro ("{{ad.name}}", a preview click) names no ad. */
const utm = (v: string | null) => (v && !v.startsWith("{{") ? v : null);

/**
 * The registration came through a Meta ad (Facebook or Instagram): its utm_source says so, or, with no source, it carries an
 * ad's campaign. One with neither came some other way (organic, email, a shared or typed link) and is not in Meta's landing
 * page views, so the opt-in rate leaves it out (2026-11-26: counting them put it at 10.6% against GHL's 9%).
 */
export const fromAd = (r: { utm_source: string | null; utm_campaign: string | null }) =>
  r.utm_source ? /facebook|instagram|^fb|^ig|meta/i.test(r.utm_source) : !!utm(r.utm_campaign);

/** Gave a name plus an email or a phone. */
export const gaveContact = (r: { full_name: string | null; email: string | null; phone: string | null }) =>
  !!normName(r.full_name) && !!(normEmail(r.email) || normPhone(r.phone));

/** The funnel's people from its registrations and every appointment (test and team entries are already out of both tables). */
export function buildPeople(regs: RegRecord[], appts: ApptRecord[]): FunnelPerson[] {
  const records: Contactish[] = [
    ...regs.map((r) => ({ key: `r:${r.submission_id}`, contactId: r.contact_id, name: r.full_name, email: r.email, phone: r.phone })),
    ...appts.map((a) => ({ key: `a:${a.id}`, contactId: a.contact_id, name: a.full_name, email: a.email, phone: a.phone })),
  ];
  const group = groupPeople(records);
  const booked = new Set(appts.map((a) => group.get(`a:${a.id}`)!));
  const byPerson = new Map<string, RegRecord[]>();
  for (const r of regs) {
    if (!gaveContact(r)) continue;
    const g = group.get(`r:${r.submission_id}`)!;
    const list = byPerson.get(g) ?? [];
    list.push(r);
    byPerson.set(g, list);
  }
  return [...byPerson.entries()].map(([id, rs]) => {
    rs.sort((a, b) => +a.created_at - +b.created_at);
    const first = rs[0]!;
    return {
      id, addedAt: first.created_at, contactId: first.contact_id,
      contactIds: [...new Set(rs.map((r) => r.contact_id).filter((x): x is string => !!x))],
      booked: booked.has(id),
      campaign: utm(first.utm_campaign), adset: utm(first.utm_content), ad: utm(first.utm_term),
      sessionAt: first.session_at,
      regs: rs.map((r) => ({ at: r.created_at, sessionAt: r.session_at, campaign: utm(r.utm_campaign), adset: utm(r.utm_content), ad: utm(r.utm_term), fromAd: fromAd(r) })),
    };
  });
}

export type PartialCounts = { registrants: number; booked: number; partials: number; registrantsOnAdDays: number; adRegistrantsOnAdDays: number };
type Row = { registrants: number; booked: number; partials: number };

/** A person's first registration in [from, to), or null when they didn't register then. */
const firstIn = (p: FunnelPerson, from: Date, to: Date) => p.regs.find((r) => r.at >= from && r.at < to) ?? null;

/**
 * Webinar registrants in [from, to): people who registered in those dates, each counted once however many contacts or
 * registrations they have. Each is booked or a partial, so registrants = booked + partials. `registrantsOnAdDays`: those whose
 * first registration in the dates fell on a day with ad data (cost per reg divides by it). `adRegistrantsOnAdDays`: of those,
 * the ones who came through an ad (any registration of theirs in the dates, fromAd), what the opt-in rate divides by Meta's
 * landing page views: both sides then count ad traffic only.
 */
export function countPartials(people: FunnelPerson[], from: Date, to: Date, adDays: ReadonlySet<string>, laDay: (d: Date) => string): PartialCounts {
  let registrants = 0, booked = 0, onAdDays = 0, adOnAdDays = 0;
  for (const p of people) {
    const r = firstIn(p, from, to);
    if (!r) continue;
    registrants++;
    if (p.booked) booked++;
    if (!adDays.has(laDay(r.at))) continue;
    onAdDays++;
    if (p.regs.some((x) => x.fromAd && x.at >= from && x.at < to)) adOnAdDays++;
  }
  return { registrants, booked, partials: registrants - booked, registrantsOnAdDays: onAdDays, adRegistrantsOnAdDays: adOnAdDays };
}

const add = (out: Map<string, Row>, k: string, booked: boolean) => {
  const row = out.get(k) ?? { registrants: 0, booked: 0, partials: 0 };
  row.registrants++;
  if (booked) row.booked++; else row.partials++;
  out.set(k, row);
};

/** The same split by the ad of each person's first registration in [from, to). Every row: registrants = booked + partials. */
export function partialsByAd(people: FunnelPerson[], from: Date, to: Date): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const p of people) { const r = firstIn(p, from, to); if (r) add(out, adKey(r.campaign, r.adset, r.ad), p.booked); }
  return out;
}

/** Per webinar (by its start, ISO): the people registered for it, booked or partial. Someone registered for two webinars is in both rows. */
export function partialsBySession(people: FunnelPerson[]): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const p of people) for (const s of new Set(p.regs.map((r) => r.sessionAt?.toISOString()).filter((x): x is string => !!x))) add(out, s, p.booked);
  return out;
}

export const adKey = (campaign: string | null, adset: string | null, ad: string | null) => `${campaign ?? ""}|${adset ?? ""}|${ad ?? ""}`;
