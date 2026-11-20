import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bookingsWithoutRecord, cashMismatches, classify, isProspect, numbers, packageFromProducts, packageKey, salesCallRow, trackerPayments, zoomWithoutRecord, type Appt, type Person, type ZoomSeen } from "./sales-tracker.ts";
import { SALES_TRACKER } from "./config.ts";

// The live TRC Sales Call records on 2026-11-20 (names, notes and links taken out), Nick's and one of Tiffany's.
const raw = JSON.parse(readFileSync(new URL("./fixtures/sales-calls-2026-11-20.json", import.meta.url), "utf8"));
const rows = raw.map(salesCallRow);
const NOW = new Date("2026-11-20T13:00:00Z");
const WEEK = [new Date("2026-11-16T08:00:00Z"), new Date("2026-11-23T08:00:00Z")] as const;   // Mon–Sun, Pacific
const CAL = ["7ZrKZZSaU9VvDxZ5X1h6", "klCwMLcf8vWsWTMOJyL6"];
const appts = new Map<string, Appt>();
const none = new Map<string, Person>();
const run = (o: Partial<Parameters<typeof classify>[3]> = {}, a = appts) =>
  classify(rows, a, none, { now: NOW, closers: ["nick"], calendars: CAL, basis: "evidence", shows: "salescall", ...o });

test("sales tracker: the week of Nov 16, counted from the live records", () => {
  const n = numbers(run(), WEEK[0], WEEK[1]);
  // showed: Razia (closed, outcome never filed), Austin (recorded, outcome never filed), Julie (recorded, then moved)
  assert.equal(n.showed, 3);
  assert.equal(n.noShow, 1);          // Alfred
  assert.equal(n.cancelled, 0);
  assert.equal(n.notFiled, 2);        // Pamela on the 18th, Liz on the 19th: nothing filed, not counted as no-shows
  assert.equal(n.onCalendar, 6);
  assert.equal(n.moved, 4);           // Razia x2, Pamela on the 17th, Daneza on the 20th: rescheduled slots, not calls
  assert.equal(n.upcoming, 4);        // Gwen, Anthony, Julie, Priya on the 20th
  assert.equal(n.people, 6);
  assert.equal(n.closes, 1);
  assert.equal(n.cashSalesCall, 12500);
  assert.equal(n.showRate, 3 / 4);    // over calls whose result is known
  assert.equal(n.closeRate, 1 / 6);   // over every call on the calendar
  assert.equal(n.objections.price, 2);
});

test("sales tracker: Tiffany's records are left out of every number", () => {
  const calls = run();
  assert.ok(calls.every((c) => c.closer === "nick"));
  assert.equal(calls.length, rows.length - 1);
});

test("sales tracker: filed only reads the outcomes as GHL has them", () => {
  const n = numbers(run({ basis: "filed" }), WEEK[0], WEEK[1]);
  assert.equal(n.showed, 0);
  assert.equal(n.notFiled, 4);        // Razia, Pamela, Liz, Austin
  assert.equal(n.moved, 5);           // Julie's recorded slot is a reschedule when read as filed
  assert.equal(n.onCalendar, 5);
});

test("sales tracker: a rescheduled slot with a recording is a call that happened, and the next slot is a follow-up", () => {
  const julie = run().filter((c) => c.appointment_id === "zKxulGK7HFJ8AF6lQuUn");
  assert.deepEqual(julie.map((c) => [c.status, c.followUp]), [["showed", false], ["upcoming", true]]);
  assert.ok(julie[0]!.flags.includes("moved_after_call"));
});

test("sales tracker: Zoom is read per slot from the meetings themselves (the live Zoom data of 2026-11-20)", () => {
  // what the dashboard's Zoom feed saw on Nick's bookings, a prospect in each (Razia on Nov 13 too, before any Sales Call existed)
  const z = (id: string, at: string, prospect = true): ZoomSeen => ({ appointment_id: id, start_at: new Date(at), prospect });
  const zoomSeen = [z("pkeC7HVL2O7tMd7s434b", "2026-11-13T17:59:16Z"), z("f8KR5gg7EiyJYFkHjCB5", "2026-11-16T19:00:13Z"), z("pkeC7HVL2O7tMd7s434b", "2026-11-16T20:00:07Z"),
    z("pkeC7HVL2O7tMd7s434b", "2026-11-17T18:00:25Z"), z("FaKyg2ziENmzdPTuLeRY", "2026-11-17T20:00:21Z"), z("MrwrS4MBf1vjGfkOAdDX", "2026-11-19T20:58:46Z")];
  const byId = (calls: ReturnType<typeof run>, ext: string) => calls.find((c) => c.external_id === ext)!;
  const ev = run({ zoomSeen });
  // Alfred: filed a no-show, Zoom saw him: flagged
  assert.ok(byId(ev, "f8KR5gg7EiyJYFkHjCB5").flags.includes("zoom_disagrees"));
  // Razia's noon slot, marked rescheduled: she was on Zoom, so the call happened there
  assert.equal(byId(ev, "pkeC7HVL2O7tMd7s434b@2026-11-16T20:00:00.000Z").status, "showed");
  assert.ok(byId(ev, "pkeC7HVL2O7tMd7s434b@2026-11-16T20:00:00.000Z").flags.includes("moved_after_call"));
  // her 10am slot two hours earlier is not that meeting's: still a reschedule
  assert.equal(byId(ev, "pkeC7HVL2O7tMd7s434b").status, "moved");
  // Pamela joined on the 17th; her booking moved to the 18th, where no meeting happened: the 18th is not a show
  assert.equal(byId(ev, "FaKyg2ziENmzdPTuLeRY").status, "showed");
  assert.equal(byId(ev, "FaKyg2ziENmzdPTuLeRY@2026-11-18T20:00:00.000Z").zoom, null);
  assert.equal(byId(ev, "FaKyg2ziENmzdPTuLeRY@2026-11-18T20:00:00.000Z").status, "not_filed");
  const zm = run({ zoomSeen, shows: "zoom" });
  assert.equal(byId(zm, "f8KR5gg7EiyJYFkHjCB5").status, "showed");
  assert.equal(byId(zm, "FaKyg2ziENmzdPTuLeRY@2026-11-18T20:00:00.000Z").status, "not_filed");
  // only the team or a bot in the meeting: nobody came
  const nobody = run({ zoomSeen: [z("H17kdNZcYJFV7HJiQjgp", "2026-11-19T19:01:00Z", false)], shows: "zoom" });
  assert.equal(byId(nobody, "H17kdNZcYJFV7HJiQjgp").status, "no_show");
  // Razia's Nov 13 call has no Sales Call: listed
  const ap = new Map<string, Appt>([["pkeC7HVL2O7tMd7s434b", { id: "pkeC7HVL2O7tMd7s434b", calendar_id: CAL[0]!, start_at: new Date("2026-11-17T18:00:00Z"), host_user_id: "nick-id", appointment_status: "confirmed" }]]);
  assert.deepEqual(zoomWithoutRecord(zoomSeen, rows, ap, { calendars: CAL, hostIds: ["nick-id"] }).map((x) => x.start_at.toISOString()), ["2026-11-13T17:59:16.000Z"]);
});

test("sales tracker: a note-taker bot and the team are not prospects on a Zoom call", () => {
  const team = (e: string | null) => e === "nick@tiffanyrosecoaching.com";
  assert.equal(isProspect({ name: "Nick's Fathom Notetaker", email: null }, team), false);
  assert.equal(isProspect({ name: "Nick Rowe", email: "nick@tiffanyrosecoaching.com" }, team), false);
  assert.equal(isProspect({ name: "Austin Seager", email: null }, team), true);
});

test("sales tracker: a booking with Nick as host and no Sales Call is listed", () => {
  const a: Appt[] = [
    { id: "f8KR5gg7EiyJYFkHjCB5", calendar_id: CAL[0]!, start_at: new Date("2026-11-16T19:00:00Z"), host_user_id: "nick-id", appointment_status: "confirmed" },
    { id: "missing", calendar_id: CAL[0]!, start_at: new Date("2026-11-18T19:00:00Z"), host_user_id: "nick-id", appointment_status: "confirmed" },
    { id: "cancelled", calendar_id: CAL[0]!, start_at: new Date("2026-11-18T19:00:00Z"), host_user_id: "nick-id", appointment_status: "cancelled" },
    { id: "tiffany", calendar_id: CAL[0]!, start_at: new Date("2026-11-18T19:00:00Z"), host_user_id: "tiff-id", appointment_status: "confirmed" },
  ];
  assert.deepEqual(bookingsWithoutRecord(a, rows, { now: NOW, calendars: CAL, hostIds: ["nick-id"], since: new Date("2026-11-01") }).map((x) => x.id), ["missing"]);
});

test("sales tracker: Whop cash counts only paid payments on or after the person's first call, and a difference is listed", () => {
  const people = new Map<string, Person>([["VFp3bKCAvcKH8Aj4Y3XM", { contact_id: "VFp3bKCAvcKH8Aj4Y3XM", name: "R", email: "r@x.com" }]]);
  const calls = classify(rows, appts, people, { now: NOW, closers: ["nick"], calendars: CAL, basis: "evidence", shows: "salescall" });
  const day = (d: Date) => new Date(d.getTime() - 24 * 3600_000);
  const pays = trackerPayments(calls, [
    { id: "leap", email: "R@x.com", paid_at: new Date("2026-11-01T00:00:00Z"), net_usd: 97, product_title: "Leap", method: "card" },
    { id: "p1", email: "r@x.com", paid_at: new Date("2026-11-17T09:34:50Z"), net_usd: 10000, product_title: "Ignite", method: "claritypay" },
    { id: "p2", email: "r@x.com", paid_at: new Date("2026-11-18T18:39:12Z"), net_usd: 2500, product_title: "Ignite", method: "sezzle" },
  ], day);
  assert.deepEqual(pays.map((p) => p.id), ["p1", "p2"]);
  assert.deepEqual(cashMismatches(calls, pays), []);
  assert.equal(cashMismatches(calls, pays.slice(0, 1)).length, 1);
});

test("sales tracker: a package written as its label is the same package as its key", () => {
  assert.equal(packageKey("Ignite + 4M bundle"), "ignite_4m_bundle");
  assert.equal(packageKey("ignite"), "ignite");
  assert.equal(packageKey("Something else"), "Something else");
  assert.equal(packageKey(null), null);
});

test("sales tracker: the package from Whop products, bundles before their parts; a custom amount says nothing", () => {
  const r = SALES_TRACKER.packageFromProduct;
  assert.equal(packageFromProducts(["**Ignite MLO Academy **"], r), "ignite");
  assert.equal(packageFromProducts(["**Ignite MLO Academy + 4M Mastermind **"], r), "ignite_mlo_4m");
  assert.equal(packageFromProducts(["Clarity Pay: 4M Mastermind + 6 Month Ignite Coaching"], r), "4m_6mo_ignite");
  assert.equal(packageFromProducts(["9997 **"], r), null);
});
