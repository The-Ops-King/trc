import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPeople, countPartials, partialsBy, type ApptRecord, type RegRecord } from "./partials.ts";
import { isTestOrTeam } from "./people.ts";

const reg = (id: string, o: Partial<RegRecord>): RegRecord => ({
  submission_id: id, contact_id: null, email: null, full_name: null, phone: null, created_at: new Date("2026-11-10T18:00:00Z"),
  session_at: null, utm_campaign: null, utm_content: null, utm_term: null, ...o,
});
const appt = (id: string, o: Partial<ApptRecord>): ApptRecord => ({ id, contact_id: null, email: null, full_name: null, phone: null, start_at: new Date("2026-11-12T18:00:00Z"), ...o });

test("partials: one person across two contacts (name + email), booked on either contact counts", () => {
  const people = buildPeople(
    [reg("1", { contact_id: "form", full_name: "Jane Doe-Smith", email: "Jane@x.com", phone: "+1 555 111 2222" })],
    [appt("a", { contact_id: "booking", full_name: "jane doe smith", email: "jane@x.com" })],
  );
  assert.equal(people.length, 1);
  assert.equal(people[0]!.booked, true);
  assert.equal(people[0]!.contactId, "form");
});

test("partials: same name and phone is the same person; a different name with the same phone is not", () => {
  const people = buildPeople(
    [reg("1", { contact_id: "c1", full_name: "Ann Lee", phone: "(555) 111-2222", email: "ann@x.com" }),
     reg("2", { contact_id: "c2", full_name: "Bob Lee", phone: "5551112222", email: "bob@x.com" })],
    [appt("a", { contact_id: "c3", full_name: "Ann Lee", phone: "+15551112222" })],
  );
  const byContact = new Map(people.map((p) => [p.contactId, p]));
  assert.equal(byContact.get("c1")!.booked, true);
  assert.equal(byContact.get("c2")!.booked, false);
});

test("partials: name plus email or phone is required; a registration with neither is nobody", () => {
  const people = buildPeople(
    [reg("1", { full_name: "No Contact" }), reg("2", { email: "noname@x.com" }), reg("3", { full_name: "Phone Only", phone: "5552223333" })],
    [],
  );
  assert.deepEqual(people.map((p) => p.booked), [false]);
});

test("partials: a cancelled booking still counts as booked; gave = booked + partials overall and per row", () => {
  const people = buildPeople(
    [reg("1", { contact_id: "c1", full_name: "A A", email: "a@x.com", utm_term: "Ad 1" }),
     reg("2", { contact_id: "c2", full_name: "B B", email: "b@x.com", utm_term: "Ad 1" }),
     reg("3", { contact_id: "c3", full_name: "C C", email: "c@x.com", utm_term: "{{ad.name}}" })],
    [appt("a", { contact_id: "c2" })],   // status is not read: any appointment is a booking
  );
  const from = new Date("2026-11-01"), to = new Date("2026-12-01");
  const all = countPartials(people, from, to, new Set(["2026-11-10"]), (d) => d.toISOString().slice(0, 10));
  assert.deepEqual(all, { gave: 3, booked: 1, partials: 2, gaveOnAdDays: 3 });
  const rows = partialsBy(people, from, to, (p) => p.ad);
  assert.deepEqual(rows.get("Ad 1"), { gave: 2, booked: 1, partials: 1 });
  assert.deepEqual(rows.get(null), { gave: 1, booked: 0, partials: 1 });
  for (const r of rows.values()) assert.equal(r.gave, r.booked + r.partials);
});

test("partials: dated by the first time they gave their contact", () => {
  const people = buildPeople(
    [reg("1", { contact_id: "c1", full_name: "A A", email: "a@x.com", created_at: new Date("2026-10-01T18:00:00Z") }),
     reg("2", { contact_id: "c1", full_name: "A A", email: "a@x.com", created_at: new Date("2026-11-05T18:00:00Z") })],
    [],
  );
  assert.equal(people.length, 1);
  assert.equal(people[0]!.addedAt.toISOString(), "2026-10-01T18:00:00.000Z");
});

test("test and team entries", () => {
  const team = new Set(["nick@tiffanyrosecoaching.com", "starowl38@gmail.com"]);
  assert.equal(isTestOrTeam("starowl38@gmail.com", "Corin", team), true);
  assert.equal(isTestOrTeam("jt+test@jtylerray.com", null, team), true);
  assert.equal(isTestOrTeam("someone@gmail.com", "Test Person", team), true);
  assert.equal(isTestOrTeam("test1@gmail.com", "Real Name", team), true);
  assert.equal(isTestOrTeam("contest.winner@gmail.com", "Real Name", team), false);
  assert.equal(isTestOrTeam("jane@gmail.com", "Jane Doe", team), true);
  assert.equal(isTestOrTeam("jane@gmail.com", "Janet Smith", team), false);
});
