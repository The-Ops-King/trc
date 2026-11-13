// Partials (Tyler, 2026-11-13): a person who gave a name plus an email or phone (a webinar registration) and has never booked a
// call on any of TRC's GHL calendars. Cancelled or no-show still counts as booked. People, not contact records (people.ts).
// One dataset, read by the dashboard and by the partial-tag sync, so the logic lives in one place.
import { groupPeople, normEmail, normName, normPhone, type Contactish } from "./people.ts";

export type RegRecord = {
  submission_id: string; contact_id: string | null; email: string | null; full_name: string | null; phone: string | null;
  created_at: Date; session_at: Date | null; utm_campaign: string | null; utm_content: string | null; utm_term: string | null;
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
};

/** A UTM value still holding Meta's macro ("{{ad.name}}", a preview click) names no ad. */
const utm = (v: string | null) => (v && !v.startsWith("{{") ? v : null);

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
    };
  });
}

export type PartialCounts = { gave: number; booked: number; partials: number; gaveOnAdDays: number };

/** People who gave their contact in [from, to), how many booked, how many are partials, and how many on days that have ad data. */
export function countPartials(people: FunnelPerson[], from: Date, to: Date, adDays: ReadonlySet<string>, laDay: (d: Date) => string): PartialCounts {
  const inR = people.filter((p) => p.addedAt >= from && p.addedAt < to);
  const booked = inR.filter((p) => p.booked).length;
  return { gave: inR.length, booked, partials: inR.length - booked, gaveOnAdDays: inR.filter((p) => adDays.has(laDay(p.addedAt))).length };
}

/** The same counts split by a key (the ad, the webinar). Every row: gave = booked + partials. */
export function partialsBy<K>(people: FunnelPerson[], from: Date, to: Date, key: (p: FunnelPerson) => K): Map<K, { gave: number; booked: number; partials: number }> {
  const out = new Map<K, { gave: number; booked: number; partials: number }>();
  for (const p of people) {
    if (p.addedAt < from || p.addedAt >= to) continue;
    const k = key(p);
    const row = out.get(k) ?? { gave: 0, booked: 0, partials: 0 };
    row.gave++;
    if (p.booked) row.booked++; else row.partials++;
    out.set(k, row);
  }
  return out;
}

export const adKey = (campaign: string | null, adset: string | null, ad: string | null) => `${campaign ?? ""}|${adset ?? ""}|${ad ?? ""}`;
