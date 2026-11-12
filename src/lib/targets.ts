// Targets, the same way PMU's dashboard does it (Tyler, 2026-11-12: "targets are the same"): GHL Custom Values whose name starts
// with "KPI", read by the daily sync into trc.kpi_targets. Rates are percents; "Max" ones are ceilings. PMU's names that mean the
// same thing here keep PMU's defaults; TRC's own (webinar) targets have no default and show no badge until they are set in GHL.

export type TargetKey =
  | "minSample" | "show" | "close" | "costPerCloseMax" | "roasMin"
  | "costPerRegistrantMax" | "registrationRate" | "attendanceRate" | "stayedRate" | "webinarConversion" | "pifRate"
  | "churnMax" | "ltvCacMin";

/** Custom Value name (lower case) → target. */
export const TARGET_NAMES: Record<string, TargetKey> = {
  "kpi min sample": "minSample",
  "kpi show rate": "show",                                  // onboarding (Leap Welcome) calls: showed of booked
  "kpi close rate": "close",                                // high-ticket buyers of those who showed to a call
  "kpi max cost per close": "costPerCloseMax",              // ad spend per new high-ticket buyer
  "kpi min roas": "roasMin",                                // high-ticket cash per $1 of ad spend
  "kpi max cost per registrant": "costPerRegistrantMax",
  "kpi registration rate": "registrationRate",
  "kpi attendance rate": "attendanceRate",
  "kpi stayed to pitch rate": "stayedRate",
  "kpi webinar conversion rate": "webinarConversion",
  "kpi pif rate": "pifRate",
  "kpi max churn rate": "churnMax",
  "kpi min ltv cac": "ltvCacMin",
};

/** PMU's defaults for the targets that mean the same thing here. */
export const DEFAULT_TARGETS: Partial<Record<TargetKey, number>> = { minSample: 10, show: 60, close: 20, costPerCloseMax: 3000, roasMin: 3 };

export type Targets = Partial<Record<TargetKey, number>>;

/** "KPI Show Rate" = "60%" → ["show", 60]; anything else → null. */
export function parseTarget(name: string, value: string): [TargetKey, number] | null {
  const key = TARGET_NAMES[name.trim().toLowerCase()];
  const n = Number(value.replace(/[$,%\s]/g, ""));
  return key && value.trim() && Number.isFinite(n) ? [key, n] : null;
}

export type Judgement = "ok" | "miss" | "thin" | null;

/** ok / miss against a target (a ceiling when `max`), "thin" when fewer than the minimum sample, null with nothing to judge. */
export function judge(value: number | null, target: number | undefined, sample: number, min: number, max = false): Judgement {
  if (value === null || target === undefined) return null;
  if (sample < min) return "thin";
  return (max ? value > target : value < target) ? "miss" : "ok";
}
