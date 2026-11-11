import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { eventRow, urlValidationAnswer, zoomSignatureOk } from "./zoom-webhook-core.ts";

const SECRET = "test-secret-token";
const sign = (ts: string, body: string) => `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;

test("signature: Zoom's v0 HMAC passes", async () => {
  const body = '{"event":"webinar.participant_joined"}', ts = "1794400000";
  assert.equal(await zoomSignatureOk(SECRET, body, ts, sign(ts, body), 1794400000 * 1000), true);
});

test("signature: wrong secret, edited body or old timestamp fail", async () => {
  const body = '{"event":"x"}', ts = "1794400000", now = 1794400000 * 1000;
  assert.equal(await zoomSignatureOk("other", body, ts, sign(ts, body), now), false);
  assert.equal(await zoomSignatureOk(SECRET, body + " ", ts, sign(ts, body), now), false);
  assert.equal(await zoomSignatureOk(SECRET, body, ts, sign(ts, body), now + 10 * 60_000), false);
  assert.equal(await zoomSignatureOk(SECRET, body, null, null, now), false);
});

test("URL validation: encryptedToken is HMAC of plainToken", async () => {
  const r = await urlValidationAnswer(SECRET, "abc123");
  assert.deepEqual(r, { plainToken: "abc123", encryptedToken: createHmac("sha256", SECRET).update("abc123").digest("hex") });
});

const joined = {
  event: "webinar.participant_joined",
  payload: { object: { id: "87654321098", uuid: "u1==", topic: "Standout", start_time: "2026-11-12T19:00:00Z",
    participant: { email: "Jane@Example.com ", user_name: "Jane D", join_time: "2026-11-12T19:02:10Z" } } },
};

test("event: joined webinar becomes a row keyed by email", () => {
  const r = eventRow(joined)!;
  assert.equal(r.zoom_type, "webinar");
  assert.equal(r.participant_key, "jane@example.com");
  assert.equal(r.at.toISOString(), "2026-11-12T19:02:10.000Z");
  assert.equal(r.instance_start?.toISOString(), "2026-11-12T19:00:00.000Z");
});

test("event: no email falls back to the name; other events are ignored", () => {
  const noEmail = { ...joined, payload: { object: { ...joined.payload.object, participant: { user_name: "Jane D", join_time: "2026-11-12T19:02:10Z" } } } };
  assert.equal(eventRow(noEmail)!.participant_key, "name:jane d");
  assert.equal(eventRow({ event: "meeting.started", payload: {} }), null);
});
