# TRC Dashboard

Webinar → onboarding → high-ticket funnel for Tiffany Rose Coaching, at
https://trc.jtylerray.com. Next.js on Vercel, data in Supabase Postgres.

## How it works

- **Sync** (`src/lib/sync.ts`) pulls HighLevel, Whop, Meta and Zoom into the
  `trc` schema. Runs daily via Vercel Cron (`vercel.json`) and on demand with
  the **Sync now** button. Each source is skipped until its keys exist, so
  adding a key in Vercel is all it takes to switch a source on.
- **Math** lives in SQL: classification rules in `db/migrations/001_init.sql`,
  metric queries in `src/lib/metrics.ts`. Definitions are also shown at the
  bottom of the dashboard.
- **Config** (forms, calendars, excluded payments) is in `src/lib/config.ts`.
- **Migrations** in `db/migrations/` run automatically on production builds.
- **Access**: one shared password (`DASHBOARD_PASSWORD`). Changing it signs
  everyone out.

## Environment variables

See `.env.example`.

## Connecting the remaining sources

**Meta Ads** (metrics 1–3)
1. Business Settings → Users → System Users → add one, assign the ad account
   with *View performance* (`ads_read`).
2. Generate a token for it (no expiry). Add `META_ACCESS_TOKEN` and
   `META_AD_ACCOUNT_ID` in Vercel. Optional: `META_CAMPAIGN_FILTER` if the ad
   account runs ads that are not for the webinar.
3. Redeploy, then press **Sync now**. The first sync backfills from Aug 1.

**Zoom** (metrics 4, 5, 8 and onboarding-call attendance)
1. As a Zoom admin: marketplace.zoom.us → Develop → Build App →
   **Server-to-Server OAuth**.
2. Scopes: read access to users, meetings, webinars and reports
   (`user:read:admin`, `meeting:read:admin`, `webinar:read:admin`,
   `report:read:admin`, or the granular read equivalents).
3. Activate the app. Add `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`,
   `ZOOM_CLIENT_SECRET` in Vercel, redeploy, **Sync now**.

**Slack** (daily report)
1. api.slack.com/apps → Create App → Incoming Webhooks → on → Add New Webhook
   → choose the channel.
2. Add `SLACK_WEBHOOK_URL` in Vercel and redeploy. The report posts after the
   daily sync (14:00 UTC).

## Development

```bash
npm install
npm test          # unit tests
npm run typecheck
npm run build     # migrations only run when VERCEL_ENV=production or MIGRATE=1
```
