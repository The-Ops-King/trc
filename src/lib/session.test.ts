import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionLabel, laWallTimeToUtc } from "./session.ts";

test("PDT session converts to UTC", () => {
  const at = parseSessionLabel("October 1st @ 11AM PT | 2PM ET", new Date("2026-09-25T12:00:00Z"));
  assert.equal(at?.toISOString(), "2026-10-01T18:00:00.000Z");
});

test("PST session (after DST ends) converts to UTC", () => {
  const at = parseSessionLabel("November 10th @ 9AM PT | 12PM ET", new Date("2026-11-07T23:55:00Z"));
  assert.equal(at?.toISOString(), "2026-11-10T17:00:00.000Z");
});

test("year rolls over for a January session registered in December", () => {
  const at = parseSessionLabel("January 5th @ 9AM PT | 12PM ET", new Date("2026-12-20T18:00:00Z"));
  assert.equal(at?.toISOString(), "2027-01-05T17:00:00.000Z");
});

test("registering shortly after the session still maps to that session", () => {
  const at = parseSessionLabel("October 13th @ 9AM PT | 12PM ET", new Date("2026-10-14T03:00:00Z"));
  assert.equal(at?.toISOString(), "2026-10-13T16:00:00.000Z");
});

test("minutes and lowercase are accepted", () => {
  const at = parseSessionLabel("august 20th @ 11:30am PT", new Date("2026-08-10T00:00:00Z"));
  assert.equal(at?.toISOString(), "2026-08-20T18:30:00.000Z");
});

test("unparseable labels return null", () => {
  assert.equal(parseSessionLabel("None", new Date()), null);
  assert.equal(parseSessionLabel("", new Date()), null);
  assert.equal(parseSessionLabel("Smarch 3rd @ 9AM PT", new Date()), null);
});

test("DST spring-forward day", () => {
  assert.equal(laWallTimeToUtc(2027, 2, 14, 9, 0).toISOString(), "2027-03-14T16:00:00.000Z");
});
