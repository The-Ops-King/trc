// Who counts as a prospect, and who is the same person. Shared by the sync (which keeps test and team entries out of every table,
// so every number on the page leaves them out alike) and by the partials dataset (dashboard and tag sync read the same one).

/** Team and agency addresses: never prospects. The GHL users of TRC's location are added to these at every sync (trc.team). */
export const INTERNAL_EMAIL = /@(jtylerray\.com|tiffanyrosecoaching\.com)$|trustfunnel|fathom\.video/i;
/** Test entries, by name or address (the same rules as PMU's dashboard). */
const TEST_NAME = /\btest(ing)?\b|\*test\*|john doe|jane doe|\basdf/i;
const TEST_EMAIL = /(^|[._+-])test(ing)?\d*([._+-]|@)/i;

/** True for a team member, an agency address or a test entry. `team` holds the team's emails, lower case. */
export function isTestOrTeam(email: string | null | undefined, name: string | null | undefined, team: ReadonlySet<string> = new Set()): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (e && (team.has(e) || INTERNAL_EMAIL.test(e) || TEST_EMAIL.test(e))) return true;
  return !!name && TEST_NAME.test(name);
}

export const normName = (n: string | null | undefined) =>
  (n ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim() || null;
export const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase() || null;
/** The last 10 digits (US numbers with or without +1); shorter numbers don't identify anyone. */
export const normPhone = (p: string | null | undefined) => { const d = (p ?? "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : null; };

export type Contactish = { key: string; contactId?: string | null; name: string | null; email: string | null; phone: string | null };

/**
 * Groups records into people: two records are one person when they are the same GHL contact, or share a name and an email, or a
 * name and a phone.
 * Returns each record's group id (the key of one record in its group). A record with no name joins only on the same email
 * (an appointment whose contact has no name yet is still the person with that email).
 */
export function groupPeople(records: Contactish[]): Map<string, string> {
  const up = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (up.get(r) !== r) r = up.get(r)!; let y = x; while (up.get(y) !== r) { const n = up.get(y)!; up.set(y, r); y = n; } return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) up.set(ra, rb); };
  const byKey = new Map<string, string>();
  const link = (k: string | null, rec: string) => { if (!k) return; const o = byKey.get(k); if (o) union(o, rec); else byKey.set(k, rec); };
  for (const r of records) up.set(r.key, r.key);
  for (const r of records) {
    const n = normName(r.name), e = normEmail(r.email), p = normPhone(r.phone);
    if (r.contactId) link(`c:${r.contactId}`, r.key);
    if (n && e) link(`ne:${n}|${e}`, r.key);
    if (n && p) link(`np:${n}|${p}`, r.key);
    if (!n && e) link(`e:${e}`, r.key);
  }
  // a nameless record (only an email) joins the named people with that email
  for (const r of records) {
    const n = normName(r.name), e = normEmail(r.email);
    if (n && e) { const o = byKey.get(`e:${e}`); if (o) union(o, r.key); }
  }
  return new Map(records.map((r) => [r.key, find(r.key)]));
}
