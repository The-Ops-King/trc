// The partial tag in GHL follows the dashboard's partials exactly (Tyler, 2026-11-13). Every hourly sync reconciles it from the
// same dataset the dashboard reads (loadFunnelPeople): the tag goes on each partial's main contact (their form contact) and comes
// off once they book. Only contacts from the funnel the dashboard covers (the Standout webinar form) are touched; a contact
// outside it that carries the tag is left alone, and so is anyone who gave their contact before PARTIAL_TAGS_FROM. Each run covers everyone, so there is no separate backfill.
// Writes only when PARTIAL_TAGS=live; otherwise it is a dry run that reports what it would change.
import type postgres from "postgres";
import * as ghl from "./ghl";
import { loadFunnelPeople } from "./dash";

/** The tag's name in TRC's GHL (Tyler: "update the tag names to partial"). */
export const PARTIAL_TAG = "partial";

/**
 * Only people who gave their contact on or after this day (Pacific) are tagged or untagged (Tyler, 2026-11-13: "just do the
 * ones since Nov 1"). Funnel contacts from before it are left alone either way. The dashboard's counts cover every date.
 */
export const PARTIAL_TAGS_FROM = new Date("2026-11-01T07:00:00Z");   // 2026-11-01 00:00 PDT

export type TagPlan = {
  mode: "dry-run" | "live";
  tag: string;
  aborted?: string;
  funnelContacts: number;
  partials: number;
  tagged: number;              // contacts carrying the tag now
  toAdd: string[];
  toRemove: string[];
  outsideFunnel: number;       // tagged contacts not from the funnel: left alone
  added?: number;
  removed?: number;
  failed?: Array<{ contactId: string; error: string }>;
  left?: number;               // changes not made this run (the write cap); the next run makes them
};

/**
 * Plans (and, live, makes) the tag changes. Aborts without writing when the dataset is empty or incomplete (no registrations,
 * no appointments, the calendars or booking contacts not fully read, no team list): a failed read would otherwise look like
 * "nobody booked" and tag everyone.
 */
export async function reconcilePartialTags(sql: postgres.Sql, creds: ghl.GhlCreds, opts: { live: boolean; maxWrites?: number; deadline?: number }): Promise<TagPlan> {
  const mode = opts.live ? "live" : "dry-run";
  const base = { mode, tag: PARTIAL_TAG, funnelContacts: 0, partials: 0, tagged: 0, toAdd: [], toRemove: [], outsideFunnel: 0 } as TagPlan;
  const [state] = await sql<{ appts_done: boolean | null; contacts_left: number; team: number }[]>`
    select (select (cursor->>'backfilled')::boolean from trc.sync_state where source = 'ghl_appointments') as appts_done,
           (select count(distinct a.contact_id)::int from trc.appointments a
             where a.contact_id is not null and not exists (select 1 from trc.ghl_contacts g where g.contact_id = a.contact_id)) as contacts_left,
           (select count(*)::int from trc.team) as team`;
  if (!state?.appts_done) return { ...base, aborted: "the calendars have not been read in full yet" };
  if (state.contacts_left > 0) return { ...base, aborted: `${state.contacts_left} booking contacts not read yet` };
  if (!state.team) return { ...base, aborted: "no team list" };

  const { people, registrations, appointments } = await loadFunnelPeople();
  if (!registrations || !appointments || !people.length) return { ...base, aborted: `empty dataset (registrations ${registrations}, appointments ${appointments}, people ${people.length})` };

  const inScope = people.filter((p) => p.addedAt >= PARTIAL_TAGS_FROM);
  const funnel = new Set(inScope.flatMap((p) => p.contactIds));
  const desired = new Set(inScope.filter((p) => !p.booked && p.contactId).map((p) => p.contactId!));
  const have = new Set((await ghl.contactsWithTag(creds, PARTIAL_TAG))
    .filter((k) => k.tags.some((t) => t.toLowerCase() === PARTIAL_TAG)).map((k) => k.id));
  const toAdd = [...desired].filter((id) => !have.has(id));
  const toRemove = [...have].filter((id) => funnel.has(id) && !desired.has(id));
  const plan: TagPlan = {
    ...base, funnelContacts: funnel.size, partials: desired.size, tagged: have.size, toAdd, toRemove,
    outsideFunnel: [...have].filter((id) => !funnel.has(id)).length,
  };
  if (!opts.live) return plan;

  // removals first: someone who booked should lose the tag before anything else happens
  const work = [...toRemove.map((id) => ({ id, add: false })), ...toAdd.map((id) => ({ id, add: true }))];
  const cap = opts.maxWrites ?? Infinity;
  let added = 0, removed = 0, done = 0;
  const failed: TagPlan["failed"] = [];
  for (const w of work) {
    if (done >= cap || (opts.deadline && Date.now() > opts.deadline)) break;
    done++;
    try {
      if (w.add) { await ghl.addTags(creds, w.id, [PARTIAL_TAG]); added++; }
      else { await ghl.removeTags(creds, w.id, [PARTIAL_TAG]); removed++; }
    } catch (err) {
      failed.push({ contactId: w.id, error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
    }
  }
  return { ...plan, added, removed, failed, left: work.length - done };
}

/** The plan without the full id lists, for the sync log. */
export const summarize = (p: TagPlan) => ({
  ...p, toAdd: p.toAdd.length, toRemove: p.toRemove.length, failed: p.failed?.length ?? 0,
  sampleAdd: p.toAdd.slice(0, 5), sampleRemove: p.toRemove.slice(0, 5),
});
