import "server-only";
import postgres from "postgres";
import { env } from "./env";

// One pool per server instance. POSTGRES_URL is Supabase's transaction pooler,
// which does not support prepared statements.
const globalForDb = globalThis as unknown as { trcSql?: postgres.Sql };

export function db(): postgres.Sql {
  if (!globalForDb.trcSql) {
    globalForDb.trcSql = postgres(env.databaseUrl(), {
      prepare: false,
      max: 5,
      idle_timeout: 20,
      onnotice: () => {},
      types: { numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) } },
    });
  }
  return globalForDb.trcSql;
}
