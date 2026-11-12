import "server-only";
import type postgres from "postgres";
import { db } from "./db";
import { env } from "./env";
import { BACKFILL_START, CALENDARS, EXCLUDED_WHOP_PAYMENT_IDS, REGISTRATION_FORMS, SESSION_FIELD_IDS, TRACKER_SHEET_ID } from "./config";
import * as sheet from "./sheet";
import { parseSessionLabel } from "./session";
import * as ghl from "./ghl";
import * as whop from "./whop";
import * as meta from "./meta";
import * as zoom from "./zoom";
import { parseTarget } from "./targets";
import { rebuildDirty } from "./zoom-webhook";

const DAY = 86_400_000;
/** Webinar start can drift from the advertised time; match Zoom instances within this window. */
const WEBINAR_MATCH_BEFORE_MS = 30 * 60_000;
const WEBINAR_MATCH_AFTER_MS = 90 * 60_000;
const CALL_MATCH_MS = 60 * 60_000;

type Result = { ok: boolean; skipped?: string; detail?: Record<string, unknown>; error?: string };
type Ctx = { sql: postgres.Sql; deadline: number };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const outOfTime = (c: Ctx) => Date.now() > c.deadline;

async function getCursor<T>(sql: postgres.Sql, source: string): Promise<T | null> {
  const [row] = await sql<{ cursor: T }[]>`select cursor from trc.sync_state where source = ${source}`;
  return row?.cursor ?? null;
}

async function setCursor(sql: postgres.Sql, source: string, cursor: unknown) {
  await sql`
    insert into trc.sync_state (source, cursor, updated_at) values (${source}, ${sql.json(cursor as postgres.JSONValue)}, now())
    on conflict (source) do update set cursor = excluded.cursor, updated_at = now()`;
}

// ---------------------------------------------------------------------------
// GHL: webinar registrations (form submissions)
// ---------------------------------------------------------------------------
async function syncRegistrations(c: Ctx, creds: ghl.GhlCreds): Promise<Result> {
  const cursor = (await getCursor<Record<string, string>>(c.sql, "ghl_registrations")) ?? {};
  const endAt = ymd(new Date(Date.now() + DAY));
  const counts: Record<string, number> = {};
  let complete = true;

  for (const form of REGISTRATION_FORMS) {
    const startAt = cursor[form.id] ?? BACKFILL_START;
    let page = 1;
    let n = 0;
    while (true) {
      if (outOfTime(c)) { complete = false; break; }
      const r = await ghl.listFormSubmissions(creds, form.id, startAt, endAt, page);
      const rows = r.submissions.map((s) => {
        const createdAt = new Date(s.createdAt);
        const label = SESSION_FIELD_IDS.map((id) => s.others?.[id]).find((v): v is string => typeof v === "string" && !!v) ?? null;
        const utm = s.others?.eventData?.url_params ?? {};
        return {
          submission_id: s.id,
          form_id: s.formId,
          contact_id: s.contactId ?? null,
          email: s.email?.trim() || null,
          created_at: createdAt,
          session_label: label,
          session_at: parseSessionLabel(label, createdAt),
          utm_source: utm.utm_source ?? null,
          utm_medium: utm.utm_medium ?? null,
          utm_campaign: utm.utm_campaign ?? null,
          utm_content: utm.utm_content ?? null,
          utm_term: utm.utm_term ?? null,
        };
      });
      if (rows.length) {
        await c.sql`
          insert into trc.registrations ${c.sql(rows)}
          on conflict (submission_id) do update set
            contact_id = excluded.contact_id, email = excluded.email, session_label = excluded.session_label,
            session_at = excluded.session_at, synced_at = now()`;
      }
      n += rows.length;
      if (!r.meta.nextPage || !rows.length) break;
      page = r.meta.nextPage;
    }
    counts[form.name] = n;
    if (complete) {
      // Next run re-reads from two days before the newest submission (late writes, timezone edges).
      const [row] = await c.sql<{ d: string | null }[]>`
        select to_char(max(created_at) - interval '2 days', 'YYYY-MM-DD') as d from trc.registrations where form_id = ${form.id}`;
      if (row?.d) cursor[form.id] = row.d;
    }
  }
  await setCursor(c.sql, "ghl_registrations", cursor);
  const [unparsed] = await c.sql<{ n: number }[]>`
    select count(*)::int as n from trc.registrations where session_at is null and session_label is not null`;
  return { ok: true, detail: { upserted: counts, complete, unparsedSessionLabels: unparsed?.n ?? 0 } };
}

// ---------------------------------------------------------------------------
// GHL: calendar appointments
// ---------------------------------------------------------------------------
async function syncAppointments(c: Ctx, creds: ghl.GhlCreds): Promise<Result> {
  const cursor = await getCursor<{ backfilled?: boolean }>(c.sql, "ghl_appointments");
  const from = cursor?.backfilled ? Date.now() - 45 * DAY : new Date(`${BACKFILL_START}T00:00:00Z`).getTime();
  const to = Date.now() + 60 * DAY;
  let upserted = 0;
  let removed = 0;

  for (const cal of CALENDARS) {
    for (let start = from; start < to; start += 30 * DAY) {
      if (outOfTime(c)) return { ok: true, detail: { upserted, removed, complete: false } };
      const events = await ghl.listCalendarEvents(creds, cal.id, start, Math.min(start + 30 * DAY, to));
      const live = events.filter((e) => !e.deleted);
      const gone = events.filter((e) => e.deleted).map((e) => e.id);
      if (gone.length) removed += (await c.sql`delete from trc.appointments where id in ${c.sql(gone)}`).count;
      const rows = live.map((e) => ({
        id: e.id,
        calendar_id: cal.id,
        kind: cal.kind,
        contact_id: e.contactId ?? null,
        email: e.appointmentMeta?.defaultFormDetails?.email?.trim() || null,
        start_at: new Date(e.startTime),
        appointment_status: e.appointmentStatus ?? null,
        meeting_url: e.address ?? null,
      }));
      if (rows.length) {
        await c.sql`
          insert into trc.appointments ${c.sql(rows)}
          on conflict (id) do update set
            calendar_id = excluded.calendar_id, kind = excluded.kind, contact_id = excluded.contact_id,
            email = coalesce(excluded.email, trc.appointments.email), start_at = excluded.start_at,
            appointment_status = excluded.appointment_status, meeting_url = excluded.meeting_url, synced_at = now()`;
        upserted += rows.length;
      }
    }
  }

  // Fill missing emails from the contact record (capped per run).
  const missing = await c.sql<{ contact_id: string }[]>`
    select distinct contact_id from trc.appointments where email is null and contact_id is not null limit 150`;
  let filled = 0;
  for (const { contact_id } of missing) {
    if (outOfTime(c)) break;
    const email = await ghl.getContactEmail(creds, contact_id);
    if (email) {
      await c.sql`update trc.appointments set email = ${email.trim()} where contact_id = ${contact_id} and email is null`;
      filled++;
    }
  }
  await setCursor(c.sql, "ghl_appointments", { backfilled: true });
  return { ok: true, detail: { upserted, removed, emailsFilled: filled } };
}

// ---------------------------------------------------------------------------
// Whop: payments
// ---------------------------------------------------------------------------
async function syncWhop(c: Ctx, key: string): Promise<Result> {
  const cursor = await getCursor<{ backfilled?: boolean }>(c.sql, "whop_payments");
  // After the first full pull, re-read 60 days each run so status changes and refunds land.
  const stopBefore = cursor?.backfilled ? Date.now() - 60 * DAY : 0;
  const excluded = new Set(EXCLUDED_WHOP_PAYMENT_IDS.map((e) => e.id));
  let after: string | null = null;
  let upserted = 0;

  while (true) {
    if (outOfTime(c)) return { ok: true, detail: { upserted, complete: false } };
    const page = await whop.listPayments(key, after);
    const rows = page.data.map((p) => ({
      id: p.id,
      status: p.status,
      substatus: p.substatus,
      email: p.customer_email?.trim() || null,
      whop_user_id: p.user?.id ?? null,
      product_id: p.product_id,
      product_title: p.line_items?.[0]?.product_title?.trim() ?? null,
      plan_id: p.variant_id ?? p.line_items?.[0]?.variant_id ?? null,
      method: p.payment_method_type,
      billing_reason: p.billing_reason,
      created_at: new Date(p.created_at),
      paid_at: p.paid_at ? new Date(p.paid_at) : null,
      total_usd: whop.money(p.usd_total ?? p.total),
      refunded_usd: whop.money(p.refunded_amount),
      financing_installments: p.financing_installments_count,
      excluded: excluded.has(p.id),
    }));
    if (rows.length) {
      await c.sql`
        insert into trc.whop_payments ${c.sql(rows)}
        on conflict (id) do update set
          status = excluded.status, substatus = excluded.substatus, email = excluded.email, method = excluded.method,
          paid_at = excluded.paid_at, total_usd = excluded.total_usd, refunded_usd = excluded.refunded_usd,
          product_title = excluded.product_title, excluded = excluded.excluded, synced_at = now()`;
      upserted += rows.length;
    }
    const oldest = rows.at(-1)?.created_at.getTime() ?? 0;
    if (!page.page_info.has_next_page || oldest < stopBefore) break;
    after = page.page_info.end_cursor;
  }
  await setCursor(c.sql, "whop_payments", { backfilled: true });
  return { ok: true, detail: { upserted } };
}

// ---------------------------------------------------------------------------
// Meta Ads: daily campaign spend
// ---------------------------------------------------------------------------
async function syncMeta(c: Ctx, creds: meta.MetaCreds): Promise<Result> {
  const cursor = await getCursor<{ backfilled?: boolean }>(c.sql, "meta_daily");
  // Meta keeps revising recent days (attribution, late spend): re-read the last 7.
  const since = cursor?.backfilled ? ymd(new Date(Date.now() - 7 * DAY)) : BACKFILL_START;
  const until = ymd(new Date());
  const ads = await meta.adDaily(creds, since, until);
  if (ads.length) {
    await c.sql.begin(async (tx) => {
      await tx`delete from trc.meta_ad_daily where date between ${since}::date and ${until}::date`;
      for (let i = 0; i < ads.length; i += 500) {
        await tx`insert into trc.meta_ad_daily ${tx(ads.slice(i, i + 500).map((d) => ({
          date: d.date, ad_id: d.adId, campaign_id: d.campaignId, campaign_name: d.campaignName, adset_name: d.adsetName, ad_name: d.adName,
          spend_usd: d.spend, impressions: d.impressions, link_clicks: d.linkClicks, outbound_clicks: d.outboundClicks,
        })))}`;
      }
    });
    // campaign totals per day, the table every spend number reads (trc.ad_daily)
    const byCampaign = new Map<string, { date: string; campaign_id: string; campaign_name: string | null; spend_usd: number; impressions: number; link_clicks: number; outbound_clicks: number; landing_page_views: number }>();
    for (const d of ads) {
      const k = `${d.date}|${d.campaignId}`;
      const r = byCampaign.get(k) ?? { date: d.date, campaign_id: d.campaignId, campaign_name: d.campaignName, spend_usd: 0, impressions: 0, link_clicks: 0, outbound_clicks: 0, landing_page_views: 0 };
      r.spend_usd += d.spend; r.impressions += d.impressions; r.link_clicks += d.linkClicks; r.outbound_clicks += d.outboundClicks; r.landing_page_views += d.landingPageViews;
      byCampaign.set(k, r);
    }
    await c.sql.begin(async (tx) => {
      await tx`delete from trc.meta_daily where date between ${since}::date and ${until}::date`;
      await tx`insert into trc.meta_daily ${tx([...byCampaign.values()])}`;
    });
  }
  // status and thumbnails are nice to have; never fail the spend over them
  let info = 0;
  try {
    const rows = await meta.adInfo(creds);
    if (rows.length) {
      await c.sql`
        insert into trc.meta_ads ${c.sql(rows.map((r) => ({ ad_id: r.adId, status: r.status, thumbnail_url: r.thumbnail, frequency_7d: r.frequency7d })))}
        on conflict (ad_id) do update set status = excluded.status, thumbnail_url = excluded.thumbnail_url, frequency_7d = excluded.frequency_7d, synced_at = now()`;
    }
    info = rows.length;
  } catch { /* reported as 0 below */ }
  await setCursor(c.sql, "meta_daily", { backfilled: true });
  return { ok: true, detail: { adRows: ads.length, adsWithStatus: info, since, until } };
}

// ---------------------------------------------------------------------------
// Zoom: webinar attendance and onboarding-call attendance
// ---------------------------------------------------------------------------
function zoomMeetingId(url: string | null): string | null {
  const m = url?.match(/zoom\.us\/(?:j|w|my)\/(\d{9,12})/);
  return m?.[1] ?? null;
}

async function syncZoom(c: Ctx, creds: zoom.ZoomCreds): Promise<Result> {
  const cursor = await getCursor<{ backfilled?: boolean }>(c.sql, "zoom");
  const fromMs = cursor?.backfilled ? Date.now() - 21 * DAY : new Date(`${BACKFILL_START}T00:00:00Z`).getTime();
  const token = await zoom.zoomToken(creds);
  const users = await zoom.listUsers(token);

  const instances: zoom.ZoomInstance[] = [];
  for (const u of users) {
    if (outOfTime(c)) return { ok: true, detail: { complete: false, stage: "listing" } };
    for (let s = fromMs; s < Date.now(); s += 30 * DAY) {
      instances.push(...(await zoom.pastMeetings(token, u.id, ymd(new Date(s)), ymd(new Date(Math.min(s + 29 * DAY, Date.now()))))));
    }
    instances.push(...(await zoom.pastWebinars(token, u.id)).filter((w) => new Date(w.start_time).getTime() >= fromMs));
  }

  // Match webinar sessions: prefer Zoom webinars, then the meeting closest to the advertised start.
  const sessions = await c.sql<{ session_at: Date }[]>`
    select distinct session_at from trc.registrations
    where session_at is not null and session_at >= ${new Date(fromMs)} and session_at <= now()`;
  const matched: Array<{ inst: zoom.ZoomInstance; kind: "webinar" | "onboarding"; sessionAt?: Date; appointmentId?: string }> = [];
  for (const { session_at } of sessions) {
    const t = session_at.getTime();
    const candidates = instances
      .filter((i) => {
        const d = new Date(i.start_time).getTime() - t;
        return d >= -WEBINAR_MATCH_BEFORE_MS && d <= WEBINAR_MATCH_AFTER_MS;
      })
      .sort((a, b) =>
        (a.type === "webinar" ? 0 : 1) - (b.type === "webinar" ? 0 : 1) ||
        Math.abs(new Date(a.start_time).getTime() - t) - Math.abs(new Date(b.start_time).getTime() - t));
    if (candidates[0]) matched.push({ inst: candidates[0], kind: "webinar", sessionAt: session_at });
  }

  // Match onboarding calls by Zoom meeting ID + start time.
  const calls = await c.sql<{ id: string; start_at: Date; meeting_url: string | null }[]>`
    select id, start_at, meeting_url from trc.appointments
    where kind = 'onboarding' and start_at >= ${new Date(fromMs)} and start_at <= now() and meeting_url like '%zoom.us%'`;
  for (const call of calls) {
    const mid = zoomMeetingId(call.meeting_url);
    if (!mid) continue;
    const inst = instances.find((i) => i.id === mid && Math.abs(new Date(i.start_time).getTime() - call.start_at.getTime()) <= CALL_MATCH_MS);
    if (inst) matched.push({ inst, kind: "onboarding", appointmentId: call.id });
    else await c.sql`update trc.appointments set zoom_attended = false where id = ${call.id} and start_at < now() - interval '2 hours'`;
  }

  for (const m of matched) {
    await c.sql`
      insert into trc.zoom_instances (uuid, zoom_id, zoom_type, kind, topic, start_at, session_at, appointment_id)
      values (${m.inst.uuid}, ${m.inst.id}, ${m.inst.type}, ${m.kind}, ${m.inst.topic}, ${new Date(m.inst.start_time)},
              ${m.sessionAt ?? null}, ${m.appointmentId ?? null})
      on conflict (uuid) do update set session_at = excluded.session_at, appointment_id = excluded.appointment_id, synced_at = now()`;
  }

  // Participant reports for instances not fetched yet (reports exist once the meeting has ended).
  const pending = await c.sql<{ uuid: string; zoom_id: string; zoom_type: "meeting" | "webinar"; kind: string; topic: string; start_at: Date; appointment_id: string | null }[]>`
    select uuid, zoom_id, zoom_type, kind, topic, start_at, appointment_id from trc.zoom_instances
    where not participants_fetched and start_at < now() - interval '3 hours'`;
  let fetched = 0;
  for (const p of pending) {
    if (outOfTime(c)) break;
    const inst: zoom.ZoomInstance = { uuid: p.uuid, id: p.zoom_id, topic: p.topic, start_time: p.start_at.toISOString(), type: p.zoom_type };
    const parts = await zoom.participants(token, inst);

    // Sum segments per person (people drop and rejoin).
    const people = new Map<string, { email: string | null; name: string | null; first: number; last: number; minutes: number }>();
    for (const x of parts) {
      const email = x.user_email?.trim().toLowerCase() || null;
      const name = x.name?.trim() || null;
      const key = email ?? (name ? `name:${name.toLowerCase()}` : null);
      if (!key) continue;
      const join = x.join_time ? new Date(x.join_time).getTime() : NaN;
      const leave = x.leave_time ? new Date(x.leave_time).getTime() : NaN;
      const cur = people.get(key) ?? { email, name, first: Infinity, last: -Infinity, minutes: 0 };
      if (Number.isFinite(join)) cur.first = Math.min(cur.first, join);
      if (Number.isFinite(leave)) cur.last = Math.max(cur.last, leave);
      cur.minutes += (x.duration ?? 0) / 60;
      people.set(key, cur);
    }
    const rows = [...people.entries()].map(([person_key, v]) => ({
      instance_uuid: p.uuid,
      person_key,
      email: v.email,
      name: v.name,
      first_join_at: Number.isFinite(v.first) ? new Date(v.first) : null,
      last_leave_at: Number.isFinite(v.last) ? new Date(v.last) : null,
      minutes: Math.round(v.minutes * 100) / 100,
    }));
    await c.sql.begin(async (tx) => {
      await tx`delete from trc.zoom_attendees where instance_uuid = ${p.uuid}`;
      if (rows.length) await tx`insert into trc.zoom_attendees ${tx(rows)}`;
      await tx`update trc.zoom_instances set participants_fetched = true, synced_at = now() where uuid = ${p.uuid}`;
      if (p.kind === "onboarding" && p.appointment_id) {
        // The host is always present, so a 1:1 call happened if at least two people joined.
        await tx`update trc.appointments set zoom_attended = ${people.size >= 2} where id = ${p.appointment_id}`;
      }
    });
    fetched++;
  }

  await setCursor(c.sql, "zoom", { backfilled: true });
  return { ok: true, detail: { users: users.length, instances: instances.length, matched: matched.length, participantReports: fetched } };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The team's tracker sheet: webinar ad spend, show-ups, $97 lead-magnet sales
// ---------------------------------------------------------------------------
async function syncTrackerSheet(c: Ctx, sheetId: string): Promise<Result> {
  const tabs = await sheet.listTabs(sheetId);

  const fbGid = tabs.get("FB Stats");
  if (!fbGid) throw new Error('tracker sheet: no "FB Stats" tab');
  const ad = sheet.parseFbStats(await sheet.fetchTab(sheetId, fbGid, "FB Stats"));
  if (ad.length) {
    await c.sql`
      insert into trc.sheet_ad_daily ${c.sql(ad.map((d) => ({ date: d.date, spend_usd: d.spend, link_clicks: d.linkClicks, impressions: d.impressions, outbound_clicks: d.outboundClicks })))}
      on conflict (date) do update set spend_usd = excluded.spend_usd, link_clicks = excluded.link_clicks,
        impressions = excluded.impressions, outbound_clicks = excluded.outbound_clicks, synced_at = now()`;
  }

  // Every month from the backfill start to this month. A month's rows are replaced as a whole, so a number the team clears is
  // cleared here too. A month whose tab does not exist yet is skipped.
  const months: Array<{ year: number; month0: number; tab: string; days: number }> = [];
  const [by, bm] = BACKFILL_START.split("-").map(Number) as [number, number];
  const nowLa = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).format(new Date());
  const [ny, nm] = nowLa.split("-").map(Number) as [number, number];
  for (let y = by, m0 = bm - 1; y < ny || (y === ny && m0 <= nm - 1); m0 === 11 ? (y++, m0 = 0) : m0++) {
    const tab = sheet.monthTabName(y, m0), gid = sheet.monthTabId(tabs, y, m0);
    if (!gid) { months.push({ year: y, month0: m0, tab, days: -1 }); continue; }
    const days = sheet.parseMonthTab(await sheet.fetchTab(sheetId, gid, tab), y, m0);
    const first = `${y}-${String(m0 + 1).padStart(2, "0")}-01`;
    await c.sql.begin(async (tx) => {
      await tx`delete from trc.sheet_webinar_day where date >= ${first}::date and date < (${first}::date + interval '1 month')`;
      if (days.length) {
        await tx`insert into trc.sheet_webinar_day ${tx(days.map((d) => ({ date: d.date, show_ups: d.showUps, lm_purchases: d.purchases, lm_cash: d.cash })))}`;
      }
    });
    months.push({ year: y, month0: m0, tab, days: days.length });
  }
  const lastSpend = ad.reduce((m, d) => (d.date > m ? d.date : m), "");
  return { ok: true, detail: { adDays: ad.length, lastSpendDay: lastSpend || null, webinarDays: Object.fromEntries(months.map((x) => [x.tab, x.days < 0 ? "no tab" : x.days])) } };
}

// ---------------------------------------------------------------------------
// Targets: GHL Custom Values named "KPI …" (see targets.ts). Replaced whole, so a target removed in GHL goes here too.
// ---------------------------------------------------------------------------
async function syncTargets(c: Ctx, creds: ghl.GhlCreds): Promise<Result> {
  const rows = (await ghl.listCustomValues(creds))
    .map((v) => ({ v, t: parseTarget(v.name, v.value) }))
    .filter((x) => x.t)
    .map((x) => ({ name: x.v.name.trim().toLowerCase(), value: x.t![1] }));
  await c.sql.begin(async (tx) => {
    await tx`delete from trc.kpi_targets`;
    if (rows.length) await tx`insert into trc.kpi_targets ${tx(rows)}`;
  });
  return { ok: true, detail: { targets: Object.fromEntries(rows.map((r) => [r.name, r.value])) } };
}

export async function runSync(trigger: "cron" | "manual", budgetMs = 270_000) {
  const sql = db();
  const c: Ctx = { sql, deadline: Date.now() + budgetMs };
  const [run] = await sql<{ id: number }[]>`insert into trc.sync_runs (trigger) values (${trigger}) returning id`;
  const results: Record<string, Result> = {};

  async function step(name: string, creds: unknown, fn: () => Promise<Result>) {
    if (!creds) { results[name] = { ok: true, skipped: "not configured" }; return; }
    try {
      results[name] = await fn();
    } catch (err) {
      results[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const g = env.ghl();
  const w = env.whop();
  const m = env.meta();
  const z = env.zoom();
  await step("ghl_registrations", g, () => syncRegistrations(c, g!));
  await step("ghl_appointments", g, () => syncAppointments(c, g!));
  await step("kpi_targets", g, () => syncTargets(c, g!));
  await step("whop_payments", w, () => syncWhop(c, w!.key));
  await step("meta_ads", m, () => syncMeta(c, m!));
  await step("tracker_sheet", TRACKER_SHEET_ID, () => syncTrackerSheet(c, TRACKER_SHEET_ID));
  // Zoom runs last: it matches against registrations and appointments synced above.
  await step("zoom", z, () => syncZoom(c, z!));
  // Attendance from the Zoom webhook's events: any meeting with events no rebuild has read yet (matches need the registrations and
  // appointments synced above).
  await step("zoom_webhook_rebuild", true, async () => ({ ok: true, detail: await rebuildDirty(sql, 200) }));

  const ok = Object.values(results).every((r) => r.ok);
  await sql`update trc.sync_runs set finished_at = now(), ok = ${ok}, detail = ${sql.json(results as postgres.JSONValue)} where id = ${run!.id}`;
  return { ok, results };
}
