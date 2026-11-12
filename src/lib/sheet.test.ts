import { test } from "node:test";
import assert from "node:assert/strict";
import { monthTabId, parseCsv, parseFbStats, parseMonthTab, parseTabList, num } from "./sheet.ts";

test("tab list: names and ids from the public view", () => {
  const html = String.raw`x;var items = [];items.push({name: "Tiffany Rose LEAP - November 2026", pageUrl: "https:\/\/docs.google.com\/x", gid: "1006011984", initialSheet: true});items.push({name: "FB Stats", pageUrl: "https:\/\/y", gid: "80080062"});`;
  const tabs = parseTabList(html);
  assert.equal(tabs.get("Tiffany Rose LEAP - November 2026"), "1006011984");
  assert.equal(tabs.get("FB Stats"), "80080062");
});

test("tab list: an unreadable page is an error, not an empty list", () => {
  assert.throws(() => parseTabList("<html>sign in</html>"), /tab list/);
});

test("csv: quotes, doubled quotes, commas inside quotes", () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\n1,2,3\n'), [["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
});

test("num: money, thousands, blanks", () => {
  assert.equal(num("$1,139.63"), 1139.63);
  assert.equal(num("20,101"), 20101);
  assert.equal(num(""), null);
});

const fb = parseCsv([
  ",Tiffany Rose LEAP,,,,,,,,,,Tiffany Rose Lead Magnet,,,,,,,,,,Tiffany Rose Standout",
  ",Date Start,Amount spent,Click (all),Link clicks,CPC,Outbound CTR,CTR,Impressions,CPMs,,Date Start,Amount spent,Click (all),Link clicks,CPC,Outbound CTR,CTR,Impressions,CPMs,,Date Start,Amount spent,Click (all),Link clicks,CPC,Outbound CTR,CTR,Impressions,CPMs",
  ",2025-01-01,368.99,227,87,4.2,0.5,1.4,15922,23.1,,2025-10-01,19.99,19,11,1.8,1.8,3.1,600,33.3,,2026-10-01,1890.45,1042,580,3.26,1.43,2.56,40639,46.52",
  ",,,,,,,,,,,,,,,,,,,,,2026-10-02,1889.02,849,535,3.53,1.49,2.36,35995,52.48",
].join("\n"));

test("FB Stats: reads only the Standout block", () => {
  assert.deepEqual(parseFbStats(fb), [
    { date: "2026-10-01", spend: 1890.45, linkClicks: 580, impressions: 40639, outboundClicks: 581 },
    { date: "2026-10-02", spend: 1889.02, linkClicks: 535, impressions: 35995, outboundClicks: 536 },
  ]);
});

const oct = parseCsv([
  ",,,,,,Tiffany Rose LEAP",
  ',"Mon, Oct 5 - Sun, Oct 11 2026"',
  ",Date,Ads Spend,Impressions,CPMs,Clicks (all),Link Clicks,CPC,Outbound CTR,CTR (all),Registrations,Opt-in Rate,Cost Per Registrations,Registered,Show Ups,Show Up %,Cost Per Show Up,Purchases,Purchase %,Cost Per Purchase,Upsells,Cash Collected,Upsell Full Amount,Grand Total,Daily Notes",
  ',"Mon, Oct 5 ","$2,239.96","37,260",$60.12,"1,044",654,$3.43,1.76%,2.80%,,0.00%,,,,,,,,,,,,$0.00',
  ',"Tue, Oct 6 ","$1,858.15","35,755",$51.97,"1,077",598,$3.11,1.67%,3.01%,,0.00%,,,65,,$0.00,13,20.00%,$0.00,,,,"$1,261.00"',
  ',TOTAL/AVG,"$12,628.59",,,,,,,,,,,,140,,,15,,,,,,"$1,455.00"',
].join("\n"));

test("month tab: webinar days only, columns by header", () => {
  assert.deepEqual(parseMonthTab(oct, 2026, 9), [{ date: "2026-10-06", showUps: 65, purchases: 13, cash: 1261 }]);
});

test("month tab: another month's rows are refused (Google returned a different tab)", () => {
  assert.deepEqual(parseMonthTab(oct, 2026, 10), []);
});

const nov = parseCsv([
  ",Date,Ads Spend,Impressions,CPMs,Clicks (all),Link Clicks,CPC (cost per link click),Outbound CTR,CTR (all),Registrations,Opt-in Rate,Cost Per Registrations,Registered,Attend,Attend %,Cost Per Attend,Call Show Ups,Call Show %,Purchases,Purchase %,Cost Per Purchase,Upsells,Close Rate,Cash Collected,Contract,Grand Total,Daily Notes",
  ',"Tue, Nov 3 ",$443.87,"9,633",$46.08,353,151,$2.94,1.57%,3.66%,31,20.53%,$14.32,29,30,103.45%,$26.29,1,500.00%,5,16.67%,$157.71,0,0.0%,,,$485.00,',
  ',"Wed, Nov 4 ",,,,,,,,,,0.00%,,"""""",,"""""","""""",2,0.00%,,,"""""",2,100.0%,"$15,554.00","$15,554.00",$1.00,',
  ',"Fri, Nov 6 ",,,,,,,,,,,,"""""",3,"""""","""""",6,0.00%,1,,"""""",3,50.0%,"$23,331.00","$23,331.00",$0.50,',
].join("\n"));

test("month tab (Nov 2026 layout): 'Attend' column; a broken Grand Total is not taken as cash", () => {
  assert.deepEqual(parseMonthTab(nov, 2026, 10), [
    { date: "2026-11-03", showUps: 30, purchases: 5, cash: 485 },
    { date: "2026-11-06", showUps: 3, purchases: 1, cash: null },
  ]);
});

test("month tab id: Excel's 31-character tab names", () => {
  const tabs = new Map([["Tiffany Rose LEAP - November 20", "1"], ["Tiffany Rose LEAP - March 2026", "2"]]);
  assert.equal(monthTabId(tabs, 2026, 10), "1");
  assert.equal(monthTabId(tabs, 2026, 2), "2");
  assert.equal(monthTabId(tabs, 2026, 11), undefined);
});
