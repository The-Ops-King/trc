import { DISPLAY_TZ } from "./config";

export const usd = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits });

export const num = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US");

/** Ratio as a percentage; "—" when either side is unknown or the denominator is 0. */
export const pct = (part: number | null | undefined, whole: number | null | undefined) =>
  part === null || part === undefined || !whole ? "—" : `${((part / whole) * 100).toFixed(1)}%`;

export const div = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || a === undefined || !b ? null : a / b;

export const sessionLabel = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d) + " PT";

export const dateTime = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d) + " PT";

export const GROUP_LABEL: Record<string, string> = { ignite: "Ignite", mastermind: "Mastermind", other: "Other (<$3k)" };
export const TYPE_LABEL: Record<string, string> = { pif: "PIF", third_party_financing: "Third-party financing", payment_plan: "Payment plan" };
