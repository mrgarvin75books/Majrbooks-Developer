/**
 * Date ranges for dashboards and reports. All values are calendar dates
 * ("YYYY-MM-DD") in the user's local time zone. They are never parsed with
 * new Date("YYYY-MM-DD"), which would be read as UTC and can shift a day.
 */

export type RangeKey = "this_month" | "last_month" | "this_quarter" | "ytd" | "last_year" | "custom";
export type CompareKey = "prior_period" | "prior_year" | "none";

export interface DateRange {
  from: string;
  to: string;
}

export const RANGE_LABELS: Record<RangeKey, string> = {
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  ytd: "Year to date",
  last_year: "Last year",
  custom: "Custom",
};

export const COMPARE_LABELS: Record<CompareKey, string> = {
  prior_period: "Previous period",
  prior_year: "Same period last year",
  none: "No comparison",
};

const pad = (n: number) => String(n).padStart(2, "0");
export const toIso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`; // m is 0-based
export const todayIso = (now = new Date()) => toIso(now.getFullYear(), now.getMonth(), now.getDate());

/** Parses "YYYY-MM-DD" into local-time parts without time-zone shifts. */
export function parseIso(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m: m - 1, d };
}

const lastDayOfMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

export function resolveRange(key: RangeKey, now = new Date(), custom?: DateRange): DateRange {
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = todayIso(now);
  switch (key) {
    case "this_month":
      return { from: toIso(y, m, 1), to: today };
    case "last_month": {
      const py = m === 0 ? y - 1 : y;
      const pm = m === 0 ? 11 : m - 1;
      return { from: toIso(py, pm, 1), to: toIso(py, pm, lastDayOfMonth(py, pm)) };
    }
    case "this_quarter":
      return { from: toIso(y, Math.floor(m / 3) * 3, 1), to: today };
    case "ytd":
      return { from: toIso(y, 0, 1), to: today };
    case "last_year":
      return { from: toIso(y - 1, 0, 1), to: toIso(y - 1, 11, 31) };
    case "custom":
      return custom && custom.from <= custom.to ? custom : { from: toIso(y, m, 1), to: today };
  }
}

/** Number of calendar days in a range, inclusive. */
export function rangeDays(r: DateRange): number {
  const a = parseIso(r.from);
  const b = parseIso(r.to);
  const ms = Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d);
  return Math.round(ms / 86_400_000) + 1;
}

function addDays(iso: string, days: number): string {
  const { y, m, d } = parseIso(iso);
  const dt = new Date(Date.UTC(y, m, d + days));
  return toIso(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
}

function shiftYear(iso: string, years: number): string {
  const { y, m, d } = parseIso(iso);
  return toIso(y + years, m, Math.min(d, lastDayOfMonth(y + years, m))); // Feb 29 -> Feb 28
}

/**
 * The range to compare against. "Previous period" is the same number of days
 * immediately before; for whole calendar months it is the previous whole
 * month (so March compares with all of February).
 */
export function compareRange(r: DateRange, key: CompareKey): DateRange | null {
  if (key === "none") return null;
  if (key === "prior_year") return { from: shiftYear(r.from, -1), to: shiftYear(r.to, -1) };

  const a = parseIso(r.from);
  const b = parseIso(r.to);
  const wholeMonths = a.d === 1 && b.d === lastDayOfMonth(b.y, b.m);
  if (wholeMonths) {
    const months = (b.y - a.y) * 12 + (b.m - a.m) + 1;
    const start = new Date(a.y, a.m - months, 1);
    const end = new Date(a.y, a.m, 0);
    return { from: toIso(start.getFullYear(), start.getMonth(), 1), to: toIso(end.getFullYear(), end.getMonth(), end.getDate()) };
  }
  const days = rangeDays(r);
  return { from: addDays(r.from, -days), to: addDays(r.from, -1) };
}

/** "Mar 1 – Mar 31, 2026" */
export function formatRange(r: DateRange): string {
  const fmt = (iso: string, withYear: boolean) => {
    const { y, m, d } = parseIso(iso);
    return new Date(y, m, d).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
  };
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return `${fmt(r.from, !sameYear)} – ${fmt(r.to, true)}`;
}

/** Percentage change, or null when there's no meaningful base. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
