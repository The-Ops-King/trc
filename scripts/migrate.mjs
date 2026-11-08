// Applies db/migrations/*.sql in order, once each, inside a transaction.
// Runs as part of `npm run build`, but only for production deployments
// (preview builds share the same database and must not change its schema).
// Set MIGRATE=1 to force it elsewhere.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const shouldRun = process.env.VERCEL_ENV === "production" || process.env.MIGRATE === "1";
if (!shouldRun) {
  console.log(`[migrate] skipped (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"})`);
  process.exit(0);
}

const url = process.env.POSTGRES_URL_NON_POOLING;
if (!url) {
  console.error("[migrate] POSTGRES_URL_NON_POOLING is not set");
  process.exit(1);
}

const dir = join(process.cwd(), "db", "migrations");
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await sql.begin(async (tx) => {
    // Serialize concurrent deploys.
    await tx`select pg_advisory_xact_lock(hashtext('trc_migrations'))`;
    await tx`create schema if not exists trc`;
    await tx`create table if not exists trc._migrations (name text primary key, applied_at timestamptz not null default now())`;
    await tx`alter table trc._migrations enable row level security`;
    const applied = new Set((await tx`select name from trc._migrations`).map((r) => r.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      console.log(`[migrate] applying ${file}`);
      await tx.unsafe(await readFile(join(dir, file), "utf8"));
      await tx`insert into trc._migrations (name) values (${file})`;
    }
  });
  console.log("[migrate] up to date");
} catch (err) {
  console.error("[migrate] failed:", err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
