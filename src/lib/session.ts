// Parses GHL webinar session labels such as "October 1st @ 11AM PT | 2PM ET".
// Labels carry no year, so the year is inferred from when the person registered:
// the session is the first matching date on or after (registration - 3 days).

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const LABEL_RE = /^\s*([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*@\s*(\d{1,2})(?::(\d{2}))?\s*([AP]M)\s*PT\b/i;
const TZ = "America/Los_Angeles";

/** Offset of America/Los_Angeles from UTC, in minutes, at the given instant. */
function laOffsetMinutes(at: Date): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value; // e.g. "GMT-07:00"
  const m = part?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -mins : mins;
}

/** Converts a Los Angeles wall-clock time to a UTC Date (DST-aware). */
export function laWallTimeToUtc(year: number, month0: number, day: number, hour: number, minute: number): Date {
  const naive = Date.UTC(year, month0, day, hour, minute);
  // Two passes handle instants near a DST switch.
  let utc = naive - laOffsetMinutes(new Date(naive)) * 60_000;
  utc = naive - laOffsetMinutes(new Date(utc)) * 60_000;
  return new Date(utc);
}

function laYear(at: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" }).format(at));
}

export function parseSessionLabel(label: string | null | undefined, registeredAt: Date): Date | null {
  if (!label) return null;
  const m = label.match(LABEL_RE);
  if (!m) return null;
  const month0 = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month0 < 0) return null;
  const day = Number(m[2]);
  let hour = Number(m[3]) % 12;
  if (m[5]!.toUpperCase() === "PM") hour += 12;
  const minute = m[4] ? Number(m[4]) : 0;
  if (day < 1 || day > 31) return null;

  const floor = registeredAt.getTime() - 3 * 86_400_000;
  const baseYear = laYear(registeredAt);
  for (const year of [baseYear, baseYear + 1]) {
    const at = laWallTimeToUtc(year, month0, day, hour, minute);
    if (at.getTime() >= floor) return at;
  }
  return null;
}
