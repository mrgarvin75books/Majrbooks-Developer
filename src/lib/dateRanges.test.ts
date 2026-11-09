import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compareRange, formatRange, percentChange, rangeDays, resolveRange } from "./dateRanges";

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 15, 30);

describe("resolveRange", () => {
  const now = at(2026, 11, 5);
  it.each([
    ["this_month", "2026-11-01", "2026-11-05"],
    ["last_month", "2026-10-01", "2026-10-31"],
    ["this_quarter", "2026-10-01", "2026-11-05"],
    ["ytd", "2026-01-01", "2026-11-05"],
    ["last_year", "2025-01-01", "2025-12-31"],
  ] as const)("%s", (key, from, to) => {
    expect(resolveRange(key, now)).toEqual({ from, to });
  });

  it("last month in January is December of last year", () => {
    expect(resolveRange("last_month", at(2026, 1, 10))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("handles leap-year February", () => {
    expect(resolveRange("last_month", at(2028, 3, 2))).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("falls back from an inverted custom range", () => {
    expect(resolveRange("custom", now, { from: "2026-05-01", to: "2026-04-01" }).from).toBe("2026-11-01");
  });
});

describe("compareRange", () => {
  it("compares a whole month with the whole previous month", () => {
    expect(compareRange({ from: "2026-03-01", to: "2026-03-31" }, "prior_period")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("compares a quarter-to-date with the same number of preceding days", () => {
    expect(compareRange({ from: "2026-10-01", to: "2026-11-05" }, "prior_period")).toEqual({ from: "2026-08-26", to: "2026-09-30" });
  });

  it("compares with the same dates last year, clamping Feb 29", () => {
    expect(compareRange({ from: "2028-02-01", to: "2028-02-29" }, "prior_year")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  });

  it("prior period always ends the day before the range starts and never overlaps", () => {
    fc.assert(
      fc.property(fc.date({ min: new Date(2000, 0, 1), max: new Date(2040, 0, 1), noInvalidDate: true }), fc.integer({ min: 0, max: 400 }), (start, len) => {
        const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + len);
        const r = { from: iso(start), to: iso(end) };
        const c = compareRange(r, "prior_period")!;
        expect(c.to < r.from).toBe(true);
        expect(c.from <= c.to).toBe(true);
      }),
    );
  });
});

describe("helpers", () => {
  it("counts days inclusively across DST changes", () => {
    expect(rangeDays({ from: "2026-03-01", to: "2026-03-31" })).toBe(31);
    expect(rangeDays({ from: "2026-11-01", to: "2026-11-01" })).toBe(1);
  });
  it("formats ranges", () => {
    expect(formatRange({ from: "2026-03-01", to: "2026-03-31" })).toBe("Mar 1 – Mar 31, 2026");
  });
  it("percent change has no base when the prior value is zero", () => {
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(-50, -100)).toBe(50);
  });
});
