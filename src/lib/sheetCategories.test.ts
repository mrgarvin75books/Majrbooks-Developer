import { describe, expect, it } from "vitest";
import { sheetCategory } from "./sheetCategories";
import { detectColumns, parseDirectionCell, parseLines, type Cell } from "./statementImport";
import { computeSummary } from "./scheduleC";

describe("sheetCategory", () => {
  it.each([
    ["9", "Car and truck expenses"],
    ["24b", "Meals"],
    ["25", "Utilities"],
    ["27a", "Other expenses"],
    ["Line 18", "Office expense"],
    ["1", "Sales / gross receipts"],
    ["Utilities", "Utilities"],
    ["Deductible meals", "Meals"],
    ["Other expenses (from Part V, line 48)", "Other expenses"],
    ["Line 27a – Other: bank fees", "Other expenses"],
    ["Line 24b – Meals (amount paid)", "Meals"],
    ["Line 16b – Interest (loan payments)", "Other interest"],
    ["Line 9 – Car & truck (fuel)", "Car and truck expenses"],
    ["Gross receipts – Medicaid claims (Trillium / Vaya)", "Sales / gross receipts"],
    ["Other income – bank interest & misc.", "Other business income"],
  ])("line/category %p -> %p", (category, expected) => {
    expect(sheetCategory({ category })?.category).toBe(expected);
  });

  it("income lines become income", () => {
    expect(sheetCategory({ category: "1" })?.type).toBe("income");
    expect(sheetCategory({ category: "9" })?.type).toBe("expense");
  });

  it("excluded owner transfers are transfers, other exclusions are personal", () => {
    expect(sheetCategory({ treatment: "Excluded - Owner transfer in" })).toMatchObject({ type: "transfer", category: "Transfer between accounts" });
    expect(sheetCategory({ treatment: "Excluded - Investment deposit" })).toMatchObject({ type: "personal", category: "Owner draw or personal" });
    expect(sheetCategory({ category: "9", include: "N" })).toMatchObject({ type: "personal" });
  });

  it("keeps the Part V detail as a note", () => {
    expect(sheetCategory({ category: "27a", treatment: "Expense", detail: "Tuition / school fees" })?.notes).toBe("Tuition / school fees");
  });

  it("keeps the workbook's own label as the note", () => {
    expect(sheetCategory({ category: "Line 27a – Other: bank fees" })?.notes).toBe("Line 27a – Other: bank fees");
  });

  it("returns null when the sheet says nothing usable, so the rules decide", () => {
    expect(sheetCategory(undefined)).toBeNull();
    expect(sheetCategory({ category: "" })).toBeNull();
    expect(sheetCategory({ category: "Children & Family" })).toBeNull();
  });
});

describe("Schedule C columns in a workbook", () => {
  const header: Cell[] = ["Date", "Original Description", "Amount", "Debit / Credit", "Spending Category (original)", "Schedule C Treatment", "Sch C Line", "Sch C Line Description", "Part V Detail (Line 27a)", "Include on Sch C? (Y/N)"];

  it("detects a 'Category (Schedule C)' column", () => {
    expect(detectColumns(["Date", "Month", "Account", "Description", "Bank Amount", "Section", "Category (Schedule C)", "P&L Amount"]))
      .toMatchObject({ date: 0, description: 3, amount: 4, category: 6 });
  });

  it("uses a Type column for in/out when every amount is positive", () => {
    const rows: Cell[][] = [
      ["Date", "Month", "Account", "Description", "Type", "Schedule C Category", "Line", "Amount"],
      ["2025-08-01", "Aug-25", "Checking", "BP GLENBUR", "Expense", "Car and truck expenses", "9", 19.01],
      ["2025-08-04", "Aug-25", "Checking", "uShip Payout", "Income", "Gross receipts or sales", "1", 167.58],
      ["2025-08-05", "Aug-25", "Checking", "APPLE COM BILL", "Expense", "Dues/subscriptions/entertainment", "27a", 6.39],
    ];
    const map = detectColumns(rows[0]);
    // The Line column wins over the category name, which becomes the note.
    expect(map).toMatchObject({ amount: 7, direction: 4, category: 6, detail: 5 });
    const { lines } = parseLines(rows, 0, map);
    expect(lines.map((l) => l.direction)).toEqual(["out", "in", "out"]);
    expect(sheetCategory(lines[2].sheet)).toMatchObject({ category: "Other expenses", notes: "Dues/subscriptions/entertainment" });
  });

  it("ignores the Type column when the amounts are signed (a refund stays money in)", () => {
    const rows: Cell[][] = [
      ["Date", "Description", "Bank Amount", "Section"],
      ["2026-01-02", "Netflix", -26.68, "Expense"],
      ["2026-01-09", "Duplicate charge refunded", 40, "Expense"],
    ];
    expect(parseLines(rows, 0, detectColumns(rows[0])).lines.map((l) => l.direction)).toEqual(["out", "in"]);
  });

  it.each([
    ["Income", "in"], ["Credit", "in"], ["Deposit", "in"], ["Expense", "out"], ["Debit", "out"], ["Withdrawal", "out"], ["", null], ["Transfer", null],
  ])("direction cell %p -> %p", (v, d) => expect(parseDirectionCell(v)).toBe(d));

  it("leaves $0.00 lines out quietly instead of reporting them as errors", () => {
    const rows: Cell[][] = [["Date", "Description", "Amount"], ["2026-08-12", "BILL PAY Duke Energy", 0], ["2026-08-13", "Duke Energy", -120.5]];
    const r = parseLines(rows, 0, detectColumns(rows[0]));
    expect(r.lines).toHaveLength(1);
    expect(r.errors).toEqual([]);
    expect(r.zeroAmount).toBe(1);
  });

  it("applies the meals 50% limit to the total, not per meal", () => {
    // Three $0.01 meals: per-meal rounding would give 3 × 1¢ = 3¢; the form gives 50% of 3¢ = 2¢.
    const meal = { date: "2026-01-01", description: "Lunch", amount: 0.01, type: "expense" as const, category: "Meals", notes: "" };
    expect(computeSummary([meal, meal, meal]).scheduleC.line28TotalExpenses).toBe(2);
  });

  it("detects them, but not a loose spending-category column", () => {
    expect(detectColumns(header)).toMatchObject({ date: 0, description: 1, amount: 2, category: 6, treatment: 5, detail: 8, include: 9 });
    expect(detectColumns(["Date", "Description", "Amount", "Spending Category"]).category).toBeNull();
  });

  it("nets a refund against its expense line, like the workbook", () => {
    const rows: Cell[][] = [
      header,
      [new Date(2025, 7, 12), "HAPPY HEAD", -59, "Debit", "", "Expense", "27a", "", "Personal care", "Y"],
      [new Date(2025, 9, 16), "HAPPY HEAD REFUND", 59, "Credit", "", "Expense offset (refund)", "27a", "", "Personal care", "Y"],
      [new Date(2025, 10, 7), "CHICK-FIL-A", -10.47, "Debit", "", "Expense", "24b", "", "", "Y"],
      [new Date(2025, 0, 2), "TRANSFER FROM CURTIS", 250, "Credit", "", "Excluded - Owner transfer in", "", "", "", "N"],
    ];
    const { lines } = parseLines(rows, 0, detectColumns(header));
    const s = computeSummary(lines.map((l) => ({
      date: l.date, description: l.description, amount: l.cents / 100, direction: l.direction, ...sheetCategory(l.sheet)!,
    })));
    expect(s.scheduleC.expenseLines).toEqual([
      { line: "24b", label: "Deductible meals (50%)", amount: 524 },
      { line: "27a", label: "Other expenses", amount: 0 },
    ]);
    expect(s.scheduleC.line28TotalExpenses).toBe(524);
    expect(s.excluded.transfers).toBe(25000);
  });
});
