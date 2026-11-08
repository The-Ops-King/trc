import "server-only";
import { env } from "./env";
import { periodTotals, sessionMetrics } from "./metrics";
import { GROUP_LABEL, TYPE_LABEL, div, num, pct, sessionLabel, usd } from "./format";

/** Posts yesterday's numbers and the latest completed webinar session to Slack. */
export async function postDailyReport(syncOk: boolean) {
  const url = env.slackWebhookUrl();
  if (!url) return;
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  const [day, week, sessions] = await Promise.all([
    periodTotals(dayAgo, now),
    periodTotals(weekAgo, now),
    sessionMetrics(new Date(now.getTime() - 30 * 86_400_000), now),
  ]);
  const last = sessions[0];

  const lines = (t: typeof day) => [
    `Ad spend ${usd(t.ad_spend)} · Registrants ${num(t.registrants)} · Cost/reg ${usd(div(t.ad_spend, t.registrants), 2)}`,
    `Cash collected ${usd(t.cash_all)} (from webinar registrants ${usd(t.cash_webinar)})`,
    `Failed/abandoned checkouts: ${num(t.failed.people)} people, ${usd(t.failed.attempted_usd)} attempted`,
  ].join("\n");

  const mix = week.by_group
    .map((g) => `${GROUP_LABEL[g.product_group] ?? g.product_group} · ${TYPE_LABEL[g.payment_type] ?? g.payment_type}: ${g.purchases} (${usd(g.cash)})`)
    .join("\n") || "No purchases";

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "TRC daily report" } },
    { type: "section", text: { type: "mrkdwn", text: `*Last 24 hours*\n${lines(day)}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Last 7 days*\n${lines(week)}\n\n*High-ticket mix (7 days)*\n${mix}` } },
  ];
  if (last) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Latest session: ${sessionLabel(last.session_at)}*`,
          `Registrants ${num(last.registrants)} · Attended ${num(last.attendees)} (${pct(last.attendees, last.registrants)}) · Stayed to pitch ${pct(last.stayed_to_pitch, last.attendees)}`,
          `Buyers ${num(last.buyers)} · Cash ${usd(last.cash)} · Onboarding booked ${num(last.onb_booked)}, attended ${num(last.onb_attended)}`,
        ].join("\n"),
      },
    });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${syncOk ? "Data synced." : ":warning: Last sync had errors."} <${env.dashboardUrl()}|Open dashboard>` }],
  });

  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "TRC daily report", blocks }) });
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}: ${await res.text()}`);
}

