import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// db.ts: the dashboard has one database connection, and queries sent on it at the same time make Supabase's pooler stop
// answering (2026-11-10, and again 2026-11-20 when the sales tracker sent six at once and hung both tabs). No code may start
// several queries together; they run one after another.
const root = new URL("..", import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !f.endsWith(".test.ts") ? [p] : [];
});

test("no file sends database queries in parallel (Promise.all over sql)", () => {
  const bad = files(root).filter((f) => /Promise\.all(Settled)?\(\s*\[\s*(sql|tx|c\.sql)\s*[<`]/.test(readFileSync(f, "utf8")));
  assert.deepEqual(bad, []);
});
