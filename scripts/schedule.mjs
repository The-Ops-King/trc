// Installs the hourly sync (Tyler, 2026-11-13: "It should ideally update at MINIMUM once an hour"). Vercel's plan here allows a
// daily cron only, so the hour is kept by the database, the way backend-in-a-box keeps its minute: Supabase ships pg_cron and
// pg_net, and a cron job inside Postgres calls /api/cron/sync. The key it sends is kept in Supabase Vault and read when the job
// runs, so cron.job holds no secret. Runs after the migrations on production builds; re-running replaces the job (same name).
// Never fails the build: a deploy that cannot install the job still ships, says why here, and /api/cron/diagnose shows the job.
import postgres from "postgres";

const JOB = "trc-sync-hourly", KEY_NAME = "trc_cron_secret";
const shouldRun = process.env.VERCEL_ENV === "production" || process.env.MIGRATE === "1";
if (!shouldRun) { console.log("[schedule] skipped (not production)"); process.exit(0); }

const url = process.env.POSTGRES_URL_NON_POOLING;
const secret = process.env.CRON_SECRET?.trim();
const origin = (process.env.DASHBOARD_URL?.trim() || "https://trc.jtylerray.com").replace(/\/$/, "");
if (!url || !secret) { console.warn("[schedule] NOT installed: POSTGRES_URL_NON_POOLING or CRON_SECRET is missing"); process.exit(0); }
if (!/^https:\/\/[^/\s'"$]+$/.test(origin)) { console.warn(`[schedule] NOT installed: DASHBOARD_URL must be an https origin: ${origin}`); process.exit(0); }

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql`create extension if not exists pg_cron`;
  await sql`create extension if not exists pg_net`;
  const [vault] = await sql`select 1 from pg_extension where extname = 'supabase_vault'`;
  let headers;
  if (vault) {
    const [have] = await sql`select id from vault.secrets where name = ${KEY_NAME}`;
    if (have) await sql`select vault.update_secret(${have.id}, ${secret})`;
    else await sql`select vault.create_secret(${secret}, ${KEY_NAME}, 'TRC dashboard CRON_SECRET, read by the hourly sync job')`;
    headers = `jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = '${KEY_NAME}'))`;
  } else {
    headers = `$q$${JSON.stringify({ Authorization: `Bearer ${secret}` })}$q$::jsonb`;
  }
  // minute 7: off the hour, when every other scheduler on Supabase fires. pg_net waits past the route's own 300 s.
  const command = `select net.http_get(url := $q$${origin}/api/cron/sync?source=hourly$q$, headers := ${headers}, timeout_milliseconds := 310000)`;
  const [job] = await sql`select cron.schedule(${JOB}, '7 * * * *', ${command}) as jobid`;
  console.log(`[schedule] hourly sync installed (job ${job.jobid}, key in ${vault ? "Vault" : "the job command"}) → ${origin}/api/cron/sync at :07`);
} catch (err) {
  console.warn(`[schedule] NOT installed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await sql.end();
}
