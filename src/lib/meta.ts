import "server-only";
import { fetchJson, qs } from "./http";

export type MetaCreds = { token: string; adAccountId: string; apiVersion: string; campaignFilter: string | null };

type Action = { action_type: string; value: string };
type InsightRow = {
  date_start: string;
  campaign_id: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  actions?: Action[];
};

export type MetaDay = {
  date: string;
  campaignId: string;
  campaignName: string | null;
  spend: number;
  impressions: number;
  linkClicks: number;
  landingPageViews: number;
};

/** Daily campaign-level insights for [since, until] (YYYY-MM-DD, inclusive). */
export async function campaignDaily(c: MetaCreds, since: string, until: string): Promise<MetaDay[]> {
  const out: MetaDay[] = [];
  const filter = c.campaignFilter ? new RegExp(c.campaignFilter, "i") : null;
  let url: string | null =
    `https://graph.facebook.com/${c.apiVersion}/${c.adAccountId}/insights?` +
    qs({
      level: "campaign",
      time_increment: 1,
      time_range: JSON.stringify({ since, until }),
      fields: "campaign_id,campaign_name,spend,impressions,inline_link_clicks,actions",
      limit: 500,
    });
  while (url) {
    const page: { data: InsightRow[]; paging?: { next?: string } } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${c.token}` },
    });
    for (const r of page.data) {
      if (filter && !filter.test(r.campaign_name ?? "")) continue;
      const lpv = r.actions?.find((a) => a.action_type === "landing_page_view");
      out.push({
        date: r.date_start,
        campaignId: r.campaign_id,
        campaignName: r.campaign_name ?? null,
        spend: Number(r.spend ?? 0),
        impressions: Number(r.impressions ?? 0),
        linkClicks: Number(r.inline_link_clicks ?? 0),
        landingPageViews: Number(lpv?.value ?? 0),
      });
    }
    url = page.paging?.next ?? null;
  }
  return out;
}
