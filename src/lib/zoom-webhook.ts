import "server-only";
import type postgres from "postgres";
import { PITCH_MINUTE } from "./metrics";
export { eventRow, urlValidationAnswer, zoomSignatureOk } from "./zoom-webhook-core";

// Turning stored Zoom joined/left events into attendance per instance (the webhook itself is in zoom-webhook-core.ts).

/** Webinar start can drift from the advertised time: a Zoom instance belongs to the session starting within this window. */
const MATCH_BEFORE_MS = 30 * 60_000, MATCH_AFTER_MS = 90 * 60_000, CALL_MATCH_MS = 60 * 60_000;

/**
 * Rebuild one instance's attendance from its stored events: each person's first join, last leave and minutes in the room
 * (join/leave pairs, a still-open join closed at the last event seen), then match the instance to a webinar session (by start
 * time) or an onboarding call (by meeting number in the call's Zoom link and start time). Unmatched instances are left alone.
 */
export async function rebuildInstance(sql: postgres.Sql, instanceUuid: string): Promise<"webinar" | "onboarding" | "unmatched"> {
  const evs = await sql<Array<{ event: string; zoom_type: "meeting" | "webinar"; zoom_id: string; topic: string | null; instance_start: Date | null; participant_key: string; email: string | null; name: string | null; at: Date }>>`
    select event, zoom_type, zoom_id, topic, instance_start, participant_key, email, name, at from trc.zoom_events
    where instance_uuid = ${instanceUuid} order by at, id`;
  if (!evs.length) return "unmatched";
  const first = evs[0]!;
  const start = first.instance_start ?? evs.reduce((m, e) => (e.at < m ? e.at : m), first.at);
  const lastSeen = evs.at(-1)!.at;

  // which session or call is this?
  const [session] = await sql<Array<{ session_at: Date }>>`
    select session_at from trc.registrations
    where session_at between ${new Date(start.getTime() - MATCH_AFTER_MS)} and ${new Date(start.getTime() + MATCH_BEFORE_MS)}
    group by session_at order by abs(extract(epoch from session_at - ${start}::timestamptz)) limit 1`;
  const [call] = session ? [] : await sql<Array<{ id: string }>>`
    select id from trc.appointments
    where kind = 'onboarding' and meeting_url like ${"%" + first.zoom_id + "%"}
      and start_at between ${new Date(start.getTime() - CALL_MATCH_MS)} and ${new Date(start.getTime() + CALL_MATCH_MS)}
    order by abs(extract(epoch from start_at - ${start}::timestamptz)) limit 1`;
  if (!session && !call) return "unmatched";
  if (session && first.zoom_type === "meeting") {
    // a Zoom Webinar already matched to this session wins: another meeting that happened to start then is not the webinar
    const [webinar] = await sql`select 1 from trc.zoom_instances where session_at = ${session.session_at} and kind = 'webinar' and zoom_type = 'webinar' limit 1`;
    if (webinar) return "unmatched";
  }

  const people = new Map<string, { email: string | null; name: string | null; first: number; last: number; ms: number; open: number | null }>();
  for (const e of evs) {
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
      insert into trc.zoom_instances (uuid, zoom_id, zoom_type, kind, topic, start_at, session_at, appointment_id, participants_fetched)
      values (${instanceUuid}, ${first.zoom_id}, ${first.zoom_type}, ${session ? "webinar" : "onboarding"}, ${first.topic}, ${start},
              ${session?.session_at ?? null}, ${call?.id ?? null}, true)
      on conflict (uuid) do update set session_at = excluded.session_at, appointment_id = excluded.appointment_id,
        start_at = excluded.start_at, participants_fetched = true, synced_at = now()`;
    await tx`delete from trc.zoom_attendees where instance_uuid = ${instanceUuid}`;
    if (rows.length) await tx`insert into trc.zoom_attendees ${tx(rows)}`;
    if (call) await tx`update trc.appointments set zoom_attended = ${people.size >= 2} where id = ${call.id}`;
  });
  return session ? "webinar" : "onboarding";
}

/** Whether someone was still in the webinar at the pitch (PITCH_MINUTE after the start). */
export const stayedToPitch = (start: Date, lastLeave: Date | null) => !!lastLeave && lastLeave.getTime() >= start.getTime() + PITCH_MINUTE * 60_000;
