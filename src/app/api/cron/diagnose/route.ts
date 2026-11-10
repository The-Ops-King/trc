import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/auth";
import { db } from "@/lib/db";
import { lastSuccessfulSync, lastSync, periodFunnel, periodTotals, registrantsByWebinarDay, sessionMetrics } from "@/lib/metrics";

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
    ["row counts", () => db()`select (select count(*) from trc.registrations)::int as registrations, (select count(*) from trc.appointments)::int as appointments, (select count(*) from trc.whop_payments)::int as payments`],
    ["periodTotals", () => periodTotals(from, now)],
    ["periodFunnel", () => periodFunnel(from, now)],
    ["sessionMetrics", () => sessionMetrics(from, now)],
    ["registrantsByWebinarDay", () => registrantsByWebinarDay(from, now)],
    ["lastSync", () => lastSync()],
    ["lastSuccessfulSync", () => lastSuccessfulSync()],
  ];
  const out: Array<{ step: string; ms: number; ok: boolean; note?: string }> = [];
  if (new URL(request.url).searchParams.get("parallel") === "1") {
    // as the page does it: everything at once
    const t0 = Date.now();
    const settled = await Promise.race([
      Promise.allSettled(steps.map(([step, run]) => { const s0 = Date.now(); return run().then(() => ({ step, ms: Date.now() - s0 })); })),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 40_000)),
    ]);
    return NextResponse.json({ region: process.env.VERCEL_REGION ?? null, parallel: true, totalMs: Date.now() - t0,
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
  return NextResponse.json({ region: process.env.VERCEL_REGION ?? null, days, steps: out });
}
