import { NextResponse } from "next/server";
import { hasSession } from "@/lib/guard";
import { runSync } from "@/lib/sync";

export const maxDuration = 300;

// "Sync now" button on the dashboard.
export async function POST(request: Request) {
  if (!(await hasSession())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { ok } = await runSync("manual");
  return NextResponse.redirect(new URL(`/?synced=${ok ? "ok" : "error"}`, request.url), 303);
}
