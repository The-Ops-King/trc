import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { eventRow, rebuildInstance, urlValidationAnswer, zoomSignatureOk } from "@/lib/zoom-webhook";

export const maxDuration = 30;

/**
 * Zoom "Webhook only" app endpoint: participant joined / left for meetings and webinars. Every request must carry Zoom's
 * signature (ZOOM_WEBHOOK_SECRET_TOKEN, the app's Secret Token). Events are stored once and the instance's attendance rebuilt.
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
  await sql`insert into trc.zoom_events ${sql(row)} on conflict (event, instance_uuid, participant_key, at) do nothing`;
  // Attendance for this instance is rebuilt from its events; a failure here is retried by the next event or the daily sync.
  try { await rebuildInstance(sql, row.instance_uuid); }
  catch (err) { console.error(`[zoom webhook] rebuild ${row.instance_uuid}: ${err instanceof Error ? err.message : String(err)}`); }
  return NextResponse.json({ ok: true });
}
