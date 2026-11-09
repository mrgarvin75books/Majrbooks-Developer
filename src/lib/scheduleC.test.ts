import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ALL_CATEGORY_NAMES, CATEGORIES, categoryFor, computeSummary, normalizeTransactions, type ScheduleCTransaction } from "./scheduleC";

const tx = (p: Partial<ScheduleCTransaction>): ScheduleCTransaction => ({
  date: "2026-01-15", description: "x", amount: 0, category: "Other expenses", type: "expense", notes: "", ...p,
});

describe("computeSummary", () => {
  const sample = [
    tx({ type: "income", category: "Sales / gross receipts", amount: 10000 }),
    tx({ type: "income", category: "Other business income", amount: 250.5 }),
    tx({ type: "expense", category: "Cost of goods sold", amount: 3000 }),
    tx({ type: "expense", category: "Advertising", amount: 400.1 }),
    tx({ type: "expense", category: "Advertising", amount: 0.2 }),
    tx({ type: "expense", category: "Meals", amount: 200 }),
    tx({ type: "expense", category: "Software and subscriptions", amount: 49.99 }),
    tx({ type: "expense", category: "Bank and merchant fees", amount: 15 }),
    tx({ type: "transfer", category: "Transfer between accounts", amount: 5000 }),
    tx({ type: "personal", category: "Owner draw or personal", amount: 120 }),
    tx({ type: "needs_review", category: "Needs review", amount: 75 }),
  ];
  const s = computeSummary(sample);

  it("builds an exact profit and loss", () => {
    expect(s.pnl.totalIncome).toBe(1025050);
    expect(s.pnl.cogs).toBe(300000);
    expect(s.pnl.grossProfit).toBe(725050);
    expect(s.pnl.totalExpenses).toBe(40030 + 20000 + 4999 + 1500); // advertising 400.30 exact, meals full on P&L
    expect(s.pnl.netProfit).toBe(725050 - 66529);
  });

  it("puts meals at 50% on Schedule C but 100% on the P&L", () => {
    const meals = s.scheduleC.expenseLines.find((l) => l.line === "24b")!;
    expect(meals.amount).toBe(10000);
    expect(s.scheduleC.line28TotalExpenses).toBe(40030 + 10000 + 4999 + 1500);
    expect(s.scheduleC.line31NetProfit).toBe(s.scheduleC.line7GrossIncome - s.scheduleC.line28TotalExpenses);
  });

  it("maps income and COGS to lines 1, 4, 5, 6, 7", () => {
    expect(s.scheduleC.line1GrossReceipts).toBe(1000000);
    expect(s.scheduleC.line4Cogs).toBe(300000);
    expect(s.scheduleC.line5GrossProfit).toBe(700000);
    expect(s.scheduleC.line6OtherIncome).toBe(25050);
    expect(s.scheduleC.line7GrossIncome).toBe(725050);
  });

  it("collects line 27a detail and keeps transfers, personal and unreviewed items out", () => {
    expect(s.scheduleC.otherExpenseDetail.map((d) => d.category)).toEqual(["Software and subscriptions", "Bank and merchant fees"]);
    expect(s.excluded).toMatchObject({ transfers: 500000, personal: 12000, needsReview: 7500, needsReviewCount: 1 });
  });

  it("keeps the original report fields in dollars", () => {
    expect(s.total_income).toBe(10250.5);
    expect(s.expense_totals["Advertising"]).toBe(400.3);
  });

  it("totals are exact for any set of cent amounts (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.record({
        amt: fc.integer({ min: 1, max: 10_000_000 }),
        cat: fc.constantFrom(...CATEGORIES.map((c) => c.name)),
        type: fc.constantFrom("income" as const, "expense" as const),
      }), { maxLength: 80 }), (rows) => {
        const r = computeSummary(rows.map((x) => tx({ amount: x.amt / 100, category: x.cat, type: x.type })));
        expect(r.pnl.netProfit).toBe(r.pnl.totalIncome - r.pnl.cogs - r.pnl.totalExpenses);
        expect(r.pnl.totalExpenses).toBe(r.pnl.expenses.reduce((a, e) => a + e.amount, 0));
        expect(r.scheduleC.line28TotalExpenses).toBe(r.scheduleC.expenseLines.reduce((a, l) => a + l.amount, 0));
        expect(r.scheduleC.line28TotalExpenses).toBeLessThanOrEqual(r.pnl.totalExpenses);
      }),
    );
  });
});

describe("categories and normalisation", () => {
  it("maps older category names to form lines", () => {
    expect(categoryFor("Taxes & Licenses")?.line).toBe("23");
    expect(categoryFor("Software / Subscriptions")?.line).toBe("27a");
    expect(categoryFor("Meals (50% deductible)")?.line).toBe("24b");
    expect(categoryFor("Advertising & Marketing")?.line).toBe("8");
  });

  it("normalises AI and saved-report rows", () => {
    const rows = normalizeTransactions([{ date: "2026-02-01", description: "A", amount: -12.34, category: "Supplies", type: "Expense" }, null, { amount: 50, type: "weird" }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amount: 12.34, type: "expense" });
    expect(rows[1].type).toBe("income");
  });
});
