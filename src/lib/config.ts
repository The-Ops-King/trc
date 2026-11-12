// Business configuration. Change mappings here, not in the sync code.
// Product-group and payment-type rules live in SQL (db/migrations), since the
// database is where they are applied.

/** Earliest date the sync backfills. Whop sales start 2026-08-07. */
export const BACKFILL_START = "2026-08-01";

/** GHL forms whose submissions are webinar registrations. */
export const REGISTRATION_FORMS = [
  { id: "tXDzMqHo7Yfrh2fzdMIC", name: "The Standout System Webinar Form - (Offer 2 Dates)" },
  { id: "amRAI9KukjVkJjXxPoUV", name: "The Standout System Webinar Form - (Offer 2 Dates) - September Updated" },
] as const;

/**
 * GHL custom fields that hold the chosen webinar session, e.g.
 * "October 1st @ 11AM PT | 2PM ET". The first one present on a submission wins.
 */
export const SESSION_FIELD_IDS = [
  "WQPQ27c16I2yfLP94wiC", // "Radio 1398y" (September Updated form)
  "YKk3N46eHnnCfIsgGZ7n", // "Choose Webinar Date" (original form)
] as const;

export type CalendarKind = "onboarding" | "sales";

/** GHL calendars to sync and what each one is. */
export const CALENDARS: ReadonlyArray<{ id: string; name: string; kind: CalendarKind }> = [
  { id: "7ZrKZZSaU9VvDxZ5X1h6", name: "Leap Welcome Calls", kind: "onboarding" },
  { id: "3gEXPQqCm2HLzC3FikYL", name: "Reschedule Leap Welcome Calls", kind: "onboarding" },
  { id: "8kPJriAVj2KqMyWqamjZ", name: "Ignite 1-on-1 Meeting", kind: "sales" },
  { id: "fPSfnzEuQACl09MVcy3I", name: "Game Changer Call", kind: "sales" },
];

/**
 * Whop payments left out of every metric, with the reason.
 * Keep this list short and explicit.
 */
export const EXCLUDED_WHOP_PAYMENT_IDS: ReadonlyArray<{ id: string; reason: string }> = [
  { id: "pay_tivmsXmWjpAFxC", reason: "$25 Ignite charge on an archived plan (2026-08-07), looks like a checkout test" },
];

/**
 * The team's tracker sheet ("Tiffany Rose LEAP - 2026", the live one), read daily and never written to. Link-shared, so no key.
 * FB Stats → daily webinar ad spend (the "Tiffany Rose Standout" block); monthly tabs → show-ups and $97 lead-magnet sales per
 * webinar. Meta and Zoom take over spend and attendance once connected.
 */
export const TRACKER_SHEET_ID = "1o9qEtbcv17A9UIy_Km4Nn6StjBgPISvSrf7NPbXExKQ";

/** Minutes after webinar start that count as "stayed until the pitch". */
export const PITCH_MINUTE = 45;

/** Display timezone for dates on the dashboard. */
export const DISPLAY_TZ = "America/Los_Angeles";
