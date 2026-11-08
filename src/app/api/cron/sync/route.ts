import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/auth";
import { runSync } from "@/lib/sync";
import { postDailyReport } from "@/lib/slack";

export const maxDuration = 300;

// Called by Vercel Cron (vercel.json), which sends "Authorization: Bearer $CRON_SECRET".
export async function GET(request: Request) {
  const secret = env.cronSecret();
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sync = await runSync("cron");
  let slack: string = "not configured";
  if (env.slackWebhookUrl()) {
    try {
      await postDailyReport(sync.ok);
      slack = "sent";
    } catch (err) {
      slack = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return NextResponse.json({ ok: sync.ok, slack, results: sync.results });
}
