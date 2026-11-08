import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isValidSession } from "./lib/auth";

// First line of defense. Every page and API route re-checks the session itself.
export async function proxy(request: NextRequest) {
  const ok = await isValidSession(request.cookies.get(SESSION_COOKIE)?.value, process.env.DASHBOARD_PASSWORD?.trim() || null);
  if (ok) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // Everything except static assets, the login flow and the cron endpoint (which uses CRON_SECRET).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo.png|login|api/login|api/cron/).*)"],
};
