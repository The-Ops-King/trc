import "server-only";

export class HttpError extends Error {
  constructor(public status: number, public url: string, public body: string) {
    super(`HTTP ${status} for ${url.split("?")[0]}: ${body.slice(0, 300)}`);
  }
}

/**
 * fetch + JSON with retries on 429/5xx and network errors.
 * Cloudflare in front of GHL rejects requests without a User-Agent, so one is always sent.
 */
export async function fetchJson<T>(url: string, init: RequestInit = {}, attempts = 5): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", "trc-dashboard/1.0");
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, headers, cache: "no-store" });
      if (res.ok) return (await res.json()) as T;
      const body = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(res.status, url, body);
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** i);
        continue;
      }
      throw new HttpError(res.status, url, body);
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      lastErr = err;
      await sleep(500 * 2 ** i);
    }
  }
  throw lastErr;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.set(k, String(v));
  return u.toString();
}
