import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/auth";
import { runSync } from "@/lib/sync";
import { postDailyReport } from "@/lib/slack";

export const maxDuration = 300;

// Called by Vercel Cron once a day (vercel.json), which sends "Authorization: Bearer $CRON_SECRET", and every hour by the database's
// scheduler (scripts/schedule.mjs) with ?source=hourly. Only the daily call posts the Slack report.
export async function GET(request: Request) {
  const secret = env.cronSecret();
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const hourly = new URL(request.url).searchParams.get("source") === "hourly";
  const sync = await runSync(hourly ? "hourly" : "cron");
  if (sync.skipped) return NextResponse.json({ ok: true, skipped: sync.skipped });
  let slack: string = hourly ? "hourly run: no report" : "not configured";
  if (!hourly && env.slackWebhookUrl()) {
    try {
      await postDailyReport(sync.ok);
      slack = "sent";
    } catch (err) {
      slack = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return NextResponse.json({ ok: sync.ok, slack, results: sync.results });
}
