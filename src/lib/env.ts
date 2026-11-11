// Server-only environment access. Optional integrations return null when not
// configured, so the dashboard runs with whatever sources are connected.
import "server-only";

function read(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

export function required(name: string): string {
  const v = read(name);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  dashboardPassword: () => read("DASHBOARD_PASSWORD"),
  cronSecret: () => read("CRON_SECRET"),
  databaseUrl: () => required("POSTGRES_URL"),
  ghl: () => {
    const token = read("GHL_PIT");
    const locationId = read("GHL_LOCATION") ?? read("GHL_LOCATION_ID");
    return token && locationId ? { token, locationId } : null;
  },
  whop: () => {
    const key = read("WHOP_API_KEY");
    return key ? { key } : null;
  },
  meta: () => {
    const token = read("META_ACCESS_TOKEN");
    const account = read("META_AD_ACCOUNT_ID");
    if (!token || !account) return null;
    return {
      token,
      adAccountId: account.startsWith("act_") ? account : `act_${account}`,
      apiVersion: read("META_API_VERSION") ?? "v24.0",
      campaignFilter: read("META_CAMPAIGN_FILTER"),
    };
  },
  zoom: () => {
    const accountId = read("ZOOM_ACCOUNT_ID");
    const clientId = read("ZOOM_CLIENT_ID");
    const clientSecret = read("ZOOM_CLIENT_SECRET");
    return accountId && clientId && clientSecret ? { accountId, clientId, clientSecret } : null;
  },
  /** The Zoom "Webhook only" app's Secret Token: verifies Zoom's joined/left events (no Server-to-Server OAuth needed). */
  zoomWebhookSecret: () => read("ZOOM_WEBHOOK_SECRET_TOKEN"),
  slackWebhookUrl: () => read("SLACK_WEBHOOK_URL"),
  dashboardUrl: () => read("DASHBOARD_URL") ?? "https://trc.jtylerray.com",
};
