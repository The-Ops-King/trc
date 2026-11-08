import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE, safeEqual, sessionToken } from "@/lib/auth";
import { env } from "@/lib/env";
import { sleep } from "@/lib/http";

export async function POST(request: Request) {
  const password = env.dashboardPassword();
  const form = await request.formData();
  const attempt = String(form.get("password") ?? "");
  const url = new URL(request.url);

  if (!password || !safeEqual(attempt, password)) {
    await sleep(750); // slows down guessing
    return NextResponse.redirect(new URL(password ? "/login?error=1" : "/login?error=config", url), 303);
  }
  const res = NextResponse.redirect(new URL("/", url), 303);
  res.cookies.set(SESSION_COOKIE, await sessionToken(password), {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
