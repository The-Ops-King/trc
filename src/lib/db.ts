import "server-only";
import postgres from "postgres";
import { env } from "./env";
import { transactionPoolerUrl } from "./db-url";

/** Which pooler the connection uses, for diagnostics (host suffix and port only, never credentials). */
export function poolerMode(): string {
  try {
    const u = new URL(transactionPoolerUrl(env.databaseUrl()));
    const kind = u.hostname.endsWith(".pooler.supabase.com") ? (u.port === "6543" ? "transaction pooler" : "session pooler") : "direct";
    return `${kind} (port ${u.port || "default"})`;
  } catch {
    return "unknown";
  }
}

const globalForDb = globalThis as unknown as { trcSql?: postgres.Sql };

export function db(): postgres.Sql {
  if (!globalForDb.trcSql) {
    globalForDb.trcSql = postgres(transactionPoolerUrl(env.databaseUrl()), {
      prepare: false, // the transaction pooler does not support prepared statements
      // One connection per server instance. A second connection opened alongside the first waited in Supabase's pooler and never
      // answered (2026-11-10: alone each query took milliseconds; together the page hung). One connection runs the page's queries
      // back to back in well under a second.
      max: 1,
      idle_timeout: 20,
      // fail in 10s instead of hanging when the database cannot be reached (the page has 60s in all)
      connect_timeout: 10,
      onnotice: () => {},
      types: { numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) } },
    });
  }
  return globalForDb.trcSql;
}
