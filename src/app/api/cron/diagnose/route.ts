import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/auth";
import { db, poolerMode } from "@/lib/db";
import { lastSuccessfulSync, lastSync, loadDashboard, periodFunnel, periodTotals, sessionMetrics } from "@/lib/metrics";

export const maxDuration = 300;

/**
 * Operator check (Bearer CRON_SECRET): runs each dashboard query on its own and reports how long it took, so a slow or
 * hanging page can be traced to one query in production. Reads only.
 */
export async function GET(request: Request) {
  const secret = env.cronSecret();
  if (!secret || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const days = Number(new URL(request.url).searchParams.get("days") ?? 30) || 30;
  const now = new Date();
  const from = new Date(now.getTime() - days * 86_400_000);
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["select 1", () => db()`select 1`],
    ["row counts", () => db()`select (select count(*) from trc.registrations)::int as registrations, (select count(*) from trc.appointments)::int as appointments, (select count(*) from trc.whop_payments)::int as payments,
      (select count(*) from trc.zoom_events)::int as zoom_events, (select max(received_at) from trc.zoom_events) as zoom_last_event,
      (select json_agg(json_build_object('topic', topic, 'type', zoom_type, 'events', n, 'people', p, 'matched', kind)) from (
        select e.instance_uuid, max(e.topic) as topic, max(e.zoom_type) as zoom_type, count(*) as n, count(distinct e.participant_key) as p, max(i.kind) as kind
        from trc.zoom_events e left join trc.zoom_instances i on i.uuid = e.instance_uuid
        group by e.instance_uuid order by max(e.received_at) desc limit 5) x) as zoom_recent`],
    ["periodTotals", () => periodTotals(from, now)],
    ["periodFunnel", () => periodFunnel(from, now)],
    ["sessionMetrics", () => sessionMetrics(from, now)],
    ["lastSync", () => lastSync()],
    ["lastSuccessfulSync", () => lastSuccessfulSync()],
  ];
  const out: Array<{ step: string; ms: number; ok: boolean; note?: string }> = [];
  if (new URL(request.url).searchParams.get("page") === "1") {
    // exactly what the dashboard page runs
    const t0 = Date.now(); const timings: Record<string, number> = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        loadDashboard(from, now, new Date(from.getTime() - days * 86_400_000), new Date(now.getTime() + 14 * 86_400_000), { lastMon: new Date(now.getTime() - 14 * 86_400_000), thisMon: new Date(now.getTime() - 7 * 86_400_000), nextMon: new Date(now.getTime() + 7 * 86_400_000) }, (l, ms) => { timings[l] = ms; }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("no answer within 40s")), 40_000); }),
      ]);
      return NextResponse.json({ region: process.env.VERCEL_REGION ?? null, pooler: poolerMode(), page: true, ok: true, totalMs: Date.now() - t0, timings });
    } catch (err) {
      return NextResponse.json({ region: process.env.VERCEL_REGION ?? null, pooler: poolerMode(), page: true, ok: false, error: String(err), timings });
    } finally { clearTimeout(timer); }
  }
  if (new URL(request.url).searchParams.get("parallel") === "1") {
    // as the page does it: everything at once
    const t0 = Date.now();
    const settled = await Promise.race([
      Promise.allSettled(steps.map(([step, run]) => { const s0 = Date.now(); return run().then(() => ({ step, ms: Date.now() - s0 })); })),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 40_000)),
    ]);
    return NextResponse.json({ region: process.env.VERCEL_REGION ?? null, pooler: poolerMode(), parallel: true, totalMs: Date.now() - t0,
      result: settled === "timeout" ? "no answer within 40s" : settled.map((x) => (x.status === "fulfilled" ? x.value : { error: String(x.reason) })) });
  }
  for (const [step, run] of steps) {
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([run(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("no answer within 40s")), 40_000); })]);
      out.push({ step, ms: Date.now() - t0, ok: true, ...(step === "row counts" ? { note: JSON.stringify(r) } : {}) });
    } catch (err) {
      out.push({ step, ms: Date.now() - t0, ok: false, note: err instanceof Error ? err.message : String(err) });
    } finally { clearTimeout(timer); }
  }
  return NextResponse.json({ region: process.env.VERCEL_REGION ?? null, pooler: poolerMode(), days, steps: out });
}
