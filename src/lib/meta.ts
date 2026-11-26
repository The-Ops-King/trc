import "server-only";
import { fetchJson, qs } from "./http";

export type MetaCreds = { token: string; adAccountId: string; apiVersion: string; campaignFilter: string | null };

type Action = { action_type: string; value: string };
type InsightRow = {
  date_start: string;
  campaign_id: string;
  campaign_name?: string;
  adset_name?: string;
  ad_id: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  outbound_clicks?: Action[];
  actions?: Action[];
};

export type MetaAdDay = {
  date: string;
  adId: string;
  campaignId: string;
  campaignName: string | null;
  adsetName: string | null;
  adName: string | null;
  spend: number;
  impressions: number;
  linkClicks: number;
  outboundClicks: number;
  landingPageViews: number;
};

async function pages<T>(url: string, token: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  for (let i = 0; next && i < 200; i++) {
    const page: { data: T[]; paging?: { next?: string } } = await fetchJson(next, { headers: { Authorization: `Bearer ${token}` } });
    out.push(...page.data);
    next = page.paging?.next ?? null;
  }
  return out;
}

/** Daily ad-level insights for [since, until] (YYYY-MM-DD, inclusive), campaigns outside META_CAMPAIGN_FILTER left out. */
export async function adDaily(c: MetaCreds, since: string, until: string): Promise<MetaAdDay[]> {
  const filter = c.campaignFilter ? new RegExp(c.campaignFilter, "i") : null;
  const rows = await pages<InsightRow>(
    `https://graph.facebook.com/${c.apiVersion}/${c.adAccountId}/insights?` +
      qs({
        level: "ad",
        time_increment: 1,
        time_range: JSON.stringify({ since, until }),
        fields: "campaign_id,campaign_name,adset_name,ad_id,ad_name,spend,impressions,inline_link_clicks,outbound_clicks,actions",
        limit: 500,
      }),
    c.token,
  );
  return rows
    .filter((r) => !filter || filter.test(r.campaign_name ?? ""))
    .map((r) => ({
      date: r.date_start,
      adId: r.ad_id,
      campaignId: r.campaign_id,
      campaignName: r.campaign_name ?? null,
      adsetName: r.adset_name ?? null,
      adName: r.ad_name ?? null,
      spend: Number(r.spend ?? 0),
      impressions: Number(r.impressions ?? 0),
      linkClicks: Number(r.inline_link_clicks ?? 0),
      outboundClicks: Number(r.outbound_clicks?.find((a) => a.action_type === "outbound_click")?.value ?? 0),
      landingPageViews: Number(r.actions?.find((a) => a.action_type === "landing_page_view")?.value ?? 0),
    }));
}

export type MetaAdInfo = { adId: string; status: string | null; thumbnail: string | null; frequency7d: number | null };

/** Every ad's delivery status, thumbnail, and how often the average person saw it in the last 7 days. */
export async function adInfo(c: MetaCreds): Promise<MetaAdInfo[]> {
  const ads = await pages<{ id: string; effective_status?: string; creative?: { thumbnail_url?: string } }>(
    `https://graph.facebook.com/${c.apiVersion}/${c.adAccountId}/ads?` + qs({ fields: "id,effective_status,creative{thumbnail_url}", limit: 200 }),
    c.token,
  );
  // frequency does not add up across days, so it is read for one fixed window
  const week = await pages<{ ad_id: string; frequency?: string }>(
    `https://graph.facebook.com/${c.apiVersion}/${c.adAccountId}/insights?` +
      qs({ level: "ad", date_preset: "last_7d", fields: "ad_id,frequency", limit: 500 }),
    c.token,
  ).catch(() => []);
  const freq = new Map(week.map((w) => [w.ad_id, Number(w.frequency) || null]));
  return ads.map((a) => ({ adId: a.id, status: a.effective_status ?? null, thumbnail: a.creative?.thumbnail_url ?? null, frequency7d: freq.get(a.id) ?? null }));
}

/**
 * The account's totals for [since, until] (YYYY-MM-DD, inclusive) as Ads Manager's total row shows them, every click and
 * cost measure Meta has, side by side: what the dashboard's cards use (link clicks, outbound clicks) next to the ones Ads
 * Manager offers as columns (CTR (all), unique outbound CTR, cost per landing page view...). For checking a card against Ads
 * Manager; read only. Unique counts come from Meta for the whole range (they cannot be added up day by day).
 */
export async function accountTotals(c: MetaCreds, since: string, until: string): Promise<Record<string, unknown>> {
  const rows = await pages<Record<string, unknown>>(
    `https://graph.facebook.com/${c.apiVersion}/${c.adAccountId}/insights?` +
      qs({
        level: "account",
        time_range: JSON.stringify({ since, until }),
        fields: "spend,impressions,reach,frequency,clicks,ctr,cpc,inline_link_clicks,inline_link_click_ctr,cost_per_inline_link_click,outbound_clicks,outbound_clicks_ctr,cost_per_outbound_click,unique_outbound_clicks,unique_outbound_clicks_ctr,unique_clicks,unique_ctr,actions,cost_per_action_type",
      }),
    c.token,
  );
  const r = rows[0] ?? {};
  const pick = (k: string, t: string) => ((r[k] as Array<{ action_type: string; value: string }> | undefined) ?? []).find((a) => a.action_type === t)?.value ?? null;
  const { actions: _a, cost_per_action_type: _c, ...rest } = r;
  return {
    ...rest,
    landing_page_views: pick("actions", "landing_page_view"), cost_per_landing_page_view: pick("cost_per_action_type", "landing_page_view"),
    leads: pick("actions", "lead"), cost_per_lead: pick("cost_per_action_type", "lead"),
  };
}
