import { NextResponse } from "next/server";
import { hasSession } from "@/lib/guard";
import { env } from "@/lib/env";
import { accountTotals } from "@/lib/meta";

/**
 * GET /api/meta-check?since=YYYY-MM-DD&until=YYYY-MM-DD (signed in): the ad account's totals straight from Meta for those dates,
 * every CTR and CPC Meta has (link, outbound, all, unique), to check a card against Ads Manager. Reads only.
 */
export async function GET(request: Request) {
  if (!(await hasSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const c = env.meta();
  if (!c) return NextResponse.json({ error: "Meta isn't connected" }, { status: 503 });
  const q = new URL(request.url).searchParams, day = /^\d{4}-\d{2}-\d{2}$/;
  const since = q.get("since") ?? "", until = q.get("until") ?? "";
  if (!day.test(since) || !day.test(until)) return NextResponse.json({ error: "since and until are required, YYYY-MM-DD" }, { status: 400 });
  return NextResponse.json({ since, until, account: c.adAccountId, campaignFilter: c.campaignFilter, totals: await accountTotals(c, since, until) });
}
