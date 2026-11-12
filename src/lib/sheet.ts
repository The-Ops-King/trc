// Reading the team's tracker sheet ("Webinar KPI Dashboard Main Final", an .xlsx kept in Google Drive). The sheet is link-shared, so no API key: the sheet's tab list
// (name -> tab id) is read from its public view, and each tab is downloaded as CSV with the full export, which keeps every row and
// header. (Google's by-name CSV endpoint blanks text in mostly-numeric columns, headers included, so it is not used.) A new
// month's tab is found by its name. Read only. A month tab is still only used when its rows' dates fall in that month.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON3 = MONTHS.map((m) => m.slice(0, 3));

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** "$1,139.63" → 1139.63; "20,101" → 20101; "" → null. */
export function num(s: string | undefined): number | null {
  const v = (s ?? "").replace(/[$,%\s]/g, "");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type AdDay = { date: string; spend: number; linkClicks: number | null; impressions: number | null; outboundClicks: number | null };

/**
 * The FB Stats tab: three side-by-side blocks (LEAP, Lead Magnet, Standout), each "Date Start, Amount spent, Click (all),
 * Link clicks, CPC, Outbound CTR, CTR (all), Impressions, CPMs". The webinar campaigns are the "Tiffany Rose Standout" block;
 * it is found by that title on the first row, not by position, so a moved block is still read right.
 */
export function parseFbStats(rows: string[][], block = "Tiffany Rose Standout"): AdDay[] {
  const titleRow = rows.find((r) => r.some((c) => c.trim() === block));
  if (!titleRow) throw new Error(`FB Stats: no "${block}" block`);
  const col = titleRow.findIndex((c) => c.trim() === block);
  // the block's date column is the one under (or just right of) the title holding "Date Start"
  const header = rows.find((r) => /date start/i.test(r[col] ?? "") || /date start/i.test(r[col + 1] ?? ""));
  const d = header && /date start/i.test(header[col] ?? "") ? col : col + 1;
  const out: AdDay[] = [];
  for (const r of rows) {
    const date = (r[d] ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const spend = num(r[d + 1]);
    if (spend === null) continue;
    const impressions = num(r[d + 7]), outboundCtr = num(r[d + 5]);   // Outbound CTR is a percent of impressions
    out.push({ date, spend, linkClicks: num(r[d + 3]), impressions,
      outboundClicks: impressions !== null && outboundCtr !== null ? Math.round((impressions * outboundCtr) / 100) : null });
  }
  return out;
}

export type WebinarDay = { date: string; showUps: number | null; purchases: number | null; cash: number | null };

export const monthTabName = (year: number, month0: number) => `Tiffany Rose LEAP - ${MONTHS[month0]} ${year}`;

/** A month's tab id. The sheet is an .xlsx file, whose tab names Excel cuts at 31 characters ("Tiffany Rose LEAP - November 20"). */
export function monthTabId(tabs: Map<string, string>, year: number, month0: number): string | undefined {
  const full = monthTabName(year, month0);
  return tabs.get(full) ?? tabs.get(full.slice(0, 31));
}

/**
 * A monthly tab ("Tiffany Rose LEAP - October 2026"): week blocks whose header row names the columns ("Date", "Attend" (called
 * "Show Ups" until Nov 2026), "Purchases", "Grand Total", ...), then one row per day ("Tue, Oct 6"). Columns are found by their header, not position.
 * Only days with a show-up or a purchase are returned. Rows from any other month are refused (see the note at the top).
 */
export function parseMonthTab(rows: string[][], year: number, month0: number): WebinarDay[] {
  let cols: { date: number; show: number; buys: number; total: number } | null = null;
  const out: WebinarDay[] = [];
  let foreign = 0;
  for (const r of rows) {
    const di = r.findIndex((c) => c.trim() === "Date");
    if (di >= 0 && r.some((c) => c.trim() === "Show Ups" || c.trim() === "Attend")) {
      const at = (name: string) => r.findIndex((c) => c.trim() === name);
      cols = { date: di, show: at("Attend") >= 0 ? at("Attend") : at("Show Ups"), buys: at("Purchases"), total: at("Grand Total") };
      continue;
    }
    if (!cols) continue;
    const m = (r[cols.date] ?? "").trim().match(/^[A-Z][a-z]{2}, ([A-Z][a-z]{2}) (\d{1,2})$/);
    if (!m) continue;
    const mi = MON3.indexOf(m[1]!);
    if (mi !== month0) { foreign++; continue; }
    const showUps = cols.show >= 0 ? num(r[cols.show]) : null;
    const purchases = cols.buys >= 0 ? num(r[cols.buys]) : null;
    if (!showUps && !purchases) continue;
    const date = `${year}-${String(month0 + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
    // Grand Total is a formula that goes wrong on days with high-ticket rows ($1.00 on a $15,554 day): it counts as the $97 cash
    // only when it is at least $1 per purchase
    const total = cols.total >= 0 ? num(r[cols.total]) : null;
    out.push({ date, showUps, purchases, cash: total !== null && purchases && total >= purchases ? total : null });
  }
  if (!out.length && foreign) return []; // Google handed back another tab: this month's tab does not exist yet
  return out;
}

async function getText(url: string, what: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "trc-dashboard/1.0" }, cache: "no-store", redirect: "follow" });
  if (!res.ok) throw new Error(`tracker sheet: ${res.status} reading ${what} (is the sheet still shared by link?)`);
  return res.text();
}

/** The sheet's tabs, name -> tab id, from its public view. */
export async function listTabs(sheetId: string): Promise<Map<string, string>> {
  return parseTabList(await getText(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/htmlview`, "the tab list"));
}

export function parseTabList(html: string): Map<string, string> {
  const tabs = new Map<string, string>();
  for (const m of html.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)", pageUrl: "[^"]*", gid: "(\d+)"/g)) {
    tabs.set(JSON.parse(`"${m[1]}"`) as string, m[2]!);
  }
  if (!tabs.size) throw new Error("tracker sheet: could not read its tab list (Google may have changed the page, or the sheet is no longer shared by link)");
  return tabs;
}

/** A tab by its id, full export (keeps every row, titles and headers included). */
export async function fetchTab(sheetId: string, gid: string, name: string): Promise<string[][]> {
  const text = await getText(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`, `"${name}"`);
  if (text.trimStart().startsWith("<")) throw new Error(`tracker sheet: "${name}" came back as a web page, not CSV (is the sheet still shared by link?)`);
  return parseCsv(text);
}
