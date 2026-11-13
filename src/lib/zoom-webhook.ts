import "server-only";
import type postgres from "postgres";
import { PITCH_MINUTE, WEBINAR_ZOOM_IDS } from "./config";
import { isTestOrTeam } from "./people";
export { eventRow, urlValidationAnswer, zoomSignatureOk } from "./zoom-webhook-core";

// Turning stored Zoom joined/left events into attendance per instance (the webhook itself is in zoom-webhook-core.ts).

/** Webinar start can drift from the advertised time: a Zoom instance belongs to the session starting within this window. */
const MATCH_BEFORE_MS = 30 * 60_000, MATCH_AFTER_MS = 90 * 60_000, CALL_MATCH_MS = 60 * 60_000;

/**
 * Rebuild one instance's attendance from its stored events: each person's first join, last leave and minutes in the room
 * (join/leave pairs, a still-open join closed at the last event seen), then match the instance to a webinar session (the webinar
 * room, by start time) or an onboarding call (by meeting number in the call's Zoom link and start time). Unmatched instances are
 * left alone.
 */
export async function rebuildInstance(sql: postgres.Sql, instanceUuid: string): Promise<"webinar" | "onboarding" | "unmatched"> {
  const evs = await sql<Array<{ id: number; event: string; zoom_type: "meeting" | "webinar"; zoom_id: string; topic: string | null; instance_start: Date | null; participant_key: string; email: string | null; name: string | null; at: Date }>>`
    select id::int as id, event, zoom_type, zoom_id, topic, instance_start, participant_key, email, name, at from trc.zoom_events
    where instance_uuid = ${instanceUuid} order by at, id`;
  if (!evs.length) return "unmatched";
  const through = evs.reduce((m, e) => Math.max(m, e.id), 0);
  const unmatched = async () => {
    await sql.begin(async (tx) => {
      // an earlier rebuild (under an older rule) may have matched it: that match no longer stands
      const [was] = await tx<Array<{ appointment_id: string | null }>>`delete from trc.zoom_instances where uuid = ${instanceUuid} returning appointment_id`;
      if (was?.appointment_id) await tx`update trc.appointments set zoom_attended = null where id = ${was.appointment_id}`;
      await tx`
        insert into trc.zoom_unmatched (instance_uuid, rebuilt_through) values (${instanceUuid}, ${through})
        on conflict (instance_uuid) do update set rebuilt_through = excluded.rebuilt_through, checked_at = now()`;
    });
    return "unmatched" as const;
  };
  const first = evs[0]!;
  const start = first.instance_start ?? evs.reduce((m, e) => (e.at < m ? e.at : m), first.at);
  const lastSeen = evs.at(-1)!.at;

  // which session or call is this? The webinar room (or a Zoom Webinar) is only ever a webinar session; any other meeting only
  // ever an onboarding call.
  const webinarRoom = first.zoom_type === "webinar" || WEBINAR_ZOOM_IDS.includes(first.zoom_id);
  const [session] = !webinarRoom ? [] : await sql<Array<{ session_at: Date }>>`
    select session_at from trc.registrations
    where session_at between ${new Date(start.getTime() - MATCH_AFTER_MS)} and ${new Date(start.getTime() + MATCH_BEFORE_MS)}
    group by session_at order by abs(extract(epoch from session_at - ${start}::timestamptz)) limit 1`;
  const [call] = webinarRoom ? [] : await sql<Array<{ id: string }>>`
    select id from trc.appointments
    where kind = 'onboarding' and meeting_url like ${"%" + first.zoom_id + "%"}
      and start_at between ${new Date(start.getTime() - CALL_MATCH_MS)} and ${new Date(start.getTime() + CALL_MATCH_MS)}
    order by abs(extract(epoch from start_at - ${start}::timestamptz)) limit 1`;
  if (!session && !call) return unmatched();

  // the host and the team are not attendees (and test joins are not either): the same rule as every other number
  const team = new Set((await sql<{ email: string }[]>`select email from trc.team`).map((r) => r.email));
  const people = new Map<string, { email: string | null; name: string | null; first: number; last: number; ms: number; open: number | null }>();
  for (const e of evs) {
    if (isTestOrTeam(e.email, e.name, team)) continue;
    const p = people.get(e.participant_key) ?? { email: e.email, name: e.name, first: Infinity, last: -Infinity, ms: 0, open: null };
    const t = e.at.getTime();
    if (e.event.endsWith("joined")) { p.first = Math.min(p.first, t); if (p.open === null) p.open = t; }
    else { p.last = Math.max(p.last, t); if (p.open !== null) { p.ms += t - p.open; p.open = null; } }
    p.email ??= e.email; p.name ??= e.name;
    people.set(e.participant_key, p);
  }
  const rows = [...people.entries()].map(([person_key, p]) => {
    const last = p.open !== null ? Math.max(p.last, lastSeen.getTime()) : p.last;
    const ms = p.ms + (p.open !== null ? Math.max(0, lastSeen.getTime() - p.open) : 0);
    return {
      instance_uuid: instanceUuid, person_key, email: p.email, name: p.name,
      first_join_at: Number.isFinite(p.first) ? new Date(p.first) : null,
      last_leave_at: Number.isFinite(last) ? new Date(last) : null,
      minutes: Math.round((ms / 60_000) * 100) / 100,
    };
  });

  await sql.begin(async (tx) => {
    await tx`
      insert into trc.zoom_instances (uuid, zoom_id, zoom_type, kind, topic, start_at, session_at, appointment_id, participants_fetched, rebuilt_through)
      values (${instanceUuid}, ${first.zoom_id}, ${first.zoom_type}, ${session ? "webinar" : "onboarding"}, ${first.topic}, ${start},
              ${session?.session_at ?? null}, ${call?.id ?? null}, true, ${through})
      on conflict (uuid) do update set session_at = excluded.session_at, appointment_id = excluded.appointment_id,
        start_at = excluded.start_at, participants_fetched = true, rebuilt_through = excluded.rebuilt_through, synced_at = now()`;
    await tx`delete from trc.zoom_unmatched where instance_uuid = ${instanceUuid}`;
    await tx`delete from trc.zoom_attendees where instance_uuid = ${instanceUuid}`;
    if (rows.length) await tx`insert into trc.zoom_attendees ${tx(rows)}`;
    // someone other than the team joined: the prospect showed
    if (call) await tx`update trc.appointments set zoom_attended = ${people.size >= 1} where id = ${call.id}`;
  });
  return session ? "webinar" : "onboarding";
}

/** Whether someone was still in the webinar at the pitch (PITCH_MINUTE after the start). */
export const stayedToPitch = (start: Date, lastLeave: Date | null) => !!lastLeave && lastLeave.getTime() >= start.getTime() + PITCH_MINUTE * 60_000;

/**
 * Rebuild every instance with events no rebuild has read yet (trc.zoom_dirty), one after another. Called after the webhook has
 * answered Zoom, before the dashboard reads attendance, and by the daily sync, so attendance is current whichever runs first.
 * Two servers rebuilding the same instance at once read the same events; if their writes clash one fails (logged) and the other's
 * result stands, so no lock is needed.
 */
export async function rebuildDirty(sql: postgres.Sql, limit = 50): Promise<{ rebuilt: number; left: number }> {
  const dirty = await sql<Array<{ instance_uuid: string }>>`select instance_uuid from trc.zoom_dirty order by last_event_id limit ${limit + 1}`;
  let rebuilt = 0;
  for (const d of dirty.slice(0, limit)) {
    try { await rebuildInstance(sql, d.instance_uuid); rebuilt++; }
    catch (err) { console.error(`[zoom] rebuild ${d.instance_uuid}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { rebuilt, left: Math.max(0, dirty.length - limit) };
}
