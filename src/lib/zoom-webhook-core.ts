// Zoom "Webhook only" app: signature check, URL validation and event parsing (pure, unit-tested). Zoom's rules: a request is
// signed as v0=HMAC_SHA256(secret, "v0:{x-zm-request-timestamp}:{raw body}") in x-zm-signature, and the endpoint proves itself
// by answering endpoint.url_validation with HMAC_SHA256(secret, plainToken).

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** True when the request really comes from Zoom and is recent (5 minutes, against replays). */
export async function zoomSignatureOk(secret: string, rawBody: string, timestamp: string | null, signature: string | null, nowMs = Date.now()): Promise<boolean> {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts * 1000) > 5 * 60_000) return false;
  return sameString(signature, `v0=${await hmacHex(secret, `v0:${timestamp}:${rawBody}`)}`);
}

export async function urlValidationAnswer(secret: string, plainToken: string) {
  return { plainToken, encryptedToken: await hmacHex(secret, plainToken) };
}

export const ATTENDANCE_EVENTS = ["webinar.participant_joined", "webinar.participant_left", "meeting.participant_joined", "meeting.participant_left"] as const;

type ZoomPayload = {
  event: string;
  payload?: { object?: { id?: string | number; uuid?: string; topic?: string; start_time?: string; participant?: { email?: string; user_name?: string; join_time?: string; leave_time?: string } } };
};

/** The row to store for one joined/left event, or null when it is not one we use. */
export function eventRow(body: ZoomPayload) {
  if (!(ATTENDANCE_EVENTS as readonly string[]).includes(body.event)) return null;
  const o = body.payload?.object, p = o?.participant;
  if (!o?.uuid || o.id === undefined || !p) return null;
  const email = p.email?.trim().toLowerCase() || null;
  const name = p.user_name?.trim() || null;
  const key = email ?? (name ? `name:${name.toLowerCase()}` : null);
  const at = body.event.endsWith("joined") ? p.join_time : p.leave_time;
  if (!key || !at) return null;
  return {
    event: body.event,
    zoom_type: body.event.startsWith("webinar") ? "webinar" : "meeting",
    zoom_id: String(o.id),
    instance_uuid: o.uuid,
    topic: o.topic ?? null,
    instance_start: o.start_time ? new Date(o.start_time) : null,
    participant_key: key,
    email,
    name,
    at: new Date(at),
  };
}

