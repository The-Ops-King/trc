import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, parseTarget } from "./targets.ts";

test("targets: PMU-style Custom Values", () => {
  assert.deepEqual(parseTarget("KPI Show Rate", "60%"), ["show", 60]);
  assert.deepEqual(parseTarget(" kpi max cost per close ", "$3,000"), ["costPerCloseMax", 3000]);
  assert.equal(parseTarget("KPI Unknown", "5"), null);
  assert.equal(parseTarget("KPI Show Rate", ""), null);
  assert.equal(parseTarget("KPI Show Rate", "soon"), null);
});

test("targets: floors, ceilings, thin samples", () => {
  assert.equal(judge(55, 60, 30, 10), "miss");
  assert.equal(judge(65, 60, 30, 10), "ok");
  assert.equal(judge(40, 35, 30, 10, true), "miss");
  assert.equal(judge(65, 60, 4, 10), "thin");
  assert.equal(judge(null, 60, 30, 10), null);
  assert.equal(judge(65, undefined, 30, 10), null);
});
