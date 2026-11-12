import { after, NextResponse } from "next/server";
import { db, serial } from "@/lib/db";
import { env } from "@/lib/env";
import { eventRow, rebuildDirty, urlValidationAnswer, zoomSignatureOk } from "@/lib/zoom-webhook";

export const maxDuration = 30;

/**
 * Zoom "Webhook only" app endpoint: participant joined / left for meetings and webinars. Every request must carry Zoom's
 * signature (ZOOM_WEBHOOK_SECRET_TOKEN, the app's Secret Token). The request only stores the event (once: Zoom retries) and
 * answers; attendance is rebuilt after the answer (and again by the dashboard and the daily sync, see rebuildDirty). 2026-11-12:
 * rebuilding inside the request timed out when Zoom sent a burst of joins at the start of a webinar.
 */
export async function POST(request: Request) {
  const secret = env.zoomWebhookSecret();
  if (!secret) return NextResponse.json({ error: "ZOOM_WEBHOOK_SECRET_TOKEN is not set" }, { status: 503 });
  const raw = await request.text();
  if (!(await zoomSignatureOk(secret, raw, request.headers.get("x-zm-request-timestamp"), request.headers.get("x-zm-signature")))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  let body: { event?: string; payload?: { plainToken?: string } };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  if (body.event === "endpoint.url_validation" && body.payload?.plainToken) {
    return NextResponse.json(await urlValidationAnswer(secret, body.payload.plainToken));
  }

  const row = eventRow(body as Parameters<typeof eventRow>[0]);
  if (!row) return NextResponse.json({ ok: true, ignored: body.event ?? null });
  const sql = db();
  await serial(() => sql`insert into trc.zoom_events ${sql(row)} on conflict (event, instance_uuid, participant_key, at) do nothing`);
  after(() => serial(() => rebuildDirty(sql, 5)).catch((err) => console.error(`[zoom webhook] rebuild: ${err instanceof Error ? err.message : String(err)}`)));
  return NextResponse.json({ ok: true });
}
