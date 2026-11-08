import "server-only";
import { fetchJson, qs } from "./http";

// Requires a Zoom Server-to-Server OAuth app with read access to users,
// meetings, webinars and reports (see README).

export type ZoomCreds = { accountId: string; clientId: string; clientSecret: string };

const API = "https://api.zoom.us/v2";

export async function zoomToken(c: ZoomCreds): Promise<string> {
  const basic = btoa(`${c.clientId}:${c.clientSecret}`);
  const r = await fetchJson<{ access_token: string }>(
    `https://zoom.us/oauth/token?${qs({ grant_type: "account_credentials", account_id: c.accountId })}`,
    { method: "POST", headers: { Authorization: `Basic ${basic}` } },
  );
  return r.access_token;
}

/** Zoom UUIDs that start with "/" or contain "//" must be double-encoded in paths. */
export function encodeUuid(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

async function get<T>(token: string, path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  return fetchJson<T>(`${API}${path}?${qs(params)}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function paged<T>(token: string, path: string, key: string, params: Record<string, string | number | undefined>) {
  const out: T[] = [];
  let next: string | undefined;
  do {
    const r = await get<Record<string, unknown> & { next_page_token?: string }>(token, path, {
      ...params,
      page_size: 300,
      next_page_token: next,
    });
    out.push(...((r[key] as T[] | undefined) ?? []));
    next = r.next_page_token || undefined;
  } while (next);
  return out;
}

export type ZoomUser = { id: string; email: string };
export const listUsers = (t: string) => paged<ZoomUser>(t, "/users", "users", { status: "active" });

export type ZoomInstance = { uuid: string; id: string; topic: string; start_time: string; type: "meeting" | "webinar" };

/** Past meetings for a user in [from, to] (YYYY-MM-DD, max ~1 month per call). */
export async function pastMeetings(t: string, userId: string, from: string, to: string): Promise<ZoomInstance[]> {
  const rows = await paged<{ uuid: string; id: number; topic: string; start_time: string }>(
    t, `/report/users/${encodeURIComponent(userId)}/meetings`, "meetings", { from, to, type: "past" },
  );
  return rows.map((m) => ({ uuid: m.uuid, id: String(m.id), topic: m.topic, start_time: m.start_time, type: "meeting" }));
}

/** All past webinar instances hosted by a user. */
export async function pastWebinars(t: string, userId: string): Promise<ZoomInstance[]> {
  const webinars = await paged<{ id: number; topic: string }>(t, `/users/${encodeURIComponent(userId)}/webinars`, "webinars", {});
  const out: ZoomInstance[] = [];
  for (const w of webinars) {
    const r = await get<{ webinars?: Array<{ uuid: string; start_time: string }> }>(t, `/past_webinars/${w.id}/instances`);
    for (const i of r.webinars ?? []) out.push({ uuid: i.uuid, id: String(w.id), topic: w.topic, start_time: i.start_time, type: "webinar" });
  }
  return out;
}

export type ZoomParticipant = { name?: string; user_email?: string; join_time?: string; leave_time?: string; duration?: number };

export function participants(t: string, inst: ZoomInstance) {
  const kind = inst.type === "webinar" ? "webinars" : "meetings";
  return paged<ZoomParticipant>(t, `/report/${kind}/${encodeUuid(inst.uuid)}/participants`, "participants", {});
}
