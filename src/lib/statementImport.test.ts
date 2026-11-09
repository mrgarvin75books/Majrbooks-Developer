import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  detectColumns, findHeaderRow, fingerprints, parseAmountCell, parseDateCell, parseLines, type Cell,
} from "./statementImport";
import { categorize } from "./categorizeRules";
import { ALL_CATEGORY_NAMES } from "./scheduleC";

describe("parseAmountCell", () => {
  it.each([
    [1234.5, 123450],
    ["$1,234.56", 123456],
    ["(12.00)", -1200],
    ["-12", -1200],
    ["12.00-", -1200],
    ["12.00 CR", 1200],
    ["12.00 DR", -1200],
    ["+7.5", 750],
    ["USD 10", 1000],
  ])("%p -> %p", (input, cents) => expect(parseAmountCell(input)).toBe(cents));

  it.each(["", "abc", "1.234", null, "12/01/2026"])("rejects %p", (v) => expect(parseAmountCell(v as Cell)).toBeNull());
});

describe("parseDateCell", () => {
  it.each([
    ["01/15/2026", "2026-01-15"],
    ["1/5/26", "2026-01-05"],
    ["2026-03-07", "2026-03-07"],
    ["15/01/2026", "2026-01-15"], // day first only when the first number can't be a month
    ["05-Jan-2026", "2026-01-05"],
    ["Jan 5, 2026", "2026-01-05"],
    [46037, "2026-01-15"], // Excel serial
  ])("%p -> %p", (input, iso) => expect(parseDateCell(input)).toBe(iso));

  it("handles Date objects from Excel", () => {
    expect(parseDateCell(new Date(2026, 1, 28))).toBe("2026-02-28");
  });

  it.each(["", "2/30/2026", "hello", 5])("rejects %p", (v) => expect(parseDateCell(v as Cell)).toBeNull());

  it("keeps the same day when the cell has a time", () => {
    expect(parseDateCell("01/15/2026 10:30")).toBe("2026-01-15");
    expect(parseDateCell("12/31/2026 23:59:00")).toBe("2026-12-31");
    expect(parseDateCell(new Date(2026, 0, 15, 10, 30))).toBe("2026-01-15");
    expect(parseDateCell(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });

  it("reads UTC-midnight dates as that day", () => {
    expect(parseDateCell(new Date(Date.UTC(2026, 0, 15)))).toBe("2026-01-15");
  });
});

describe("column detection and parsing", () => {
  it("reads a single signed amount column with a title block above the header", () => {
    const rows: Cell[][] = [
      ["Chase Business Checking"],
      ["Account ending 1234"],
      [],
      ["Posting Date", "Description", "Amount", "Type", "Balance"],
      ["01/02/2026", "Beginning balance", null, null, 5000],
      ["01/03/2026", "STRIPE TRANSFER ST-ABC", 2500, "ACH_CREDIT", 7500],
      ["01/04/2026", "ADOBE *CREATIVE CLOUD", -54.99, "DEBIT_CARD", 7445.01],
      ["01/04/2026", "ADOBE *CREATIVE CLOUD", -54.99, "DEBIT_CARD", 7390.02],
      ["01/05/2026", "", "", "", ""],
      ["bad date", "SOMETHING", -10, "", ""],
    ];
    const h = findHeaderRow(rows);
    expect(h).toBe(3);
    const map = detectColumns(rows[h]);
    expect(map).toMatchObject({ date: 0, description: 1, amount: 2, debit: null, credit: null });
    const res = parseLines(rows, h, map);
    expect(res.lines.map((l) => [l.date, l.cents, l.direction])).toEqual([
      ["2026-01-03", 250000, "in"],
      ["2026-01-04", 5499, "out"],
      ["2026-01-04", 5499, "out"],
    ]);
    expect(res.errors).toEqual([{ row: 10, reason: 'date "bad date" not recognised' }]);
    // Two identical lines are both kept, with distinct keys
    const fp = fingerprints(res.lines);
    expect(new Set(fp).size).toBe(3);
    // Re-importing yields the same keys (so they are skipped)
    expect(fingerprints(parseLines(rows, h, map).lines)).toEqual(fp);
  });

  it("reads separate debit and credit columns", () => {
    const rows: Cell[][] = [
      ["Date", "Transaction Details", "Withdrawals", "Deposits", "Balance"],
      ["2026-02-01", "SHELL OIL 123", "45.10", "", "1000"],
      ["2026-02-02", "CLIENT PAYMENT ACME", "", "1,200.00", "2154.90"],
    ];
    const map = detectColumns(rows[0]);
    expect(map).toMatchObject({ date: 0, description: 1, amount: null, debit: 2, credit: 3 });
    const res = parseLines(rows, 0, map);
    expect(res.lines.map((l) => [l.cents, l.direction])).toEqual([[4510, "out"], [120000, "in"]]);
  });

  it("prefers the Description column over Chase's Details (DEBIT/CREDIT) column", () => {
    const header: Cell[] = ["Details", "Posting Date", "Description", "Amount", "Type", "Balance", "Check or Slip #"];
    expect(detectColumns(header)).toMatchObject({ date: 1, description: 2, amount: 3 });
  });

  it("reads a Chase CSV end to end through SheetJS", () => {
    const csv = [
      "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
      'DEBIT,01/05/2026,"STARBUCKS #123",-4.50,DEBIT_CARD,995.50,',
      'CREDIT,01/06/2026,"STRIPE TRANSFER",1250.00,ACH_CREDIT,2245.50,',
    ].join("\n");
    const wb = XLSX.read(csv, { type: "string", cellDates: true, raw: false });
    const rows = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null, blankrows: false });
    const h = findHeaderRow(rows);
    const res = parseLines(rows, h, detectColumns(rows[h]));
    expect(res.lines.map((l) => [l.date, l.description, l.direction, l.cents])).toEqual([
      ["2026-01-05", "STARBUCKS #123", "out", 450],
      ["2026-01-06", "STRIPE TRANSFER", "in", 125000],
    ]);
  });

  it("supports banks that show money out as positive", () => {
    const rows: Cell[][] = [["Date", "Description", "Amount"], ["1/1/2026", "STAPLES", 20]];
    const res = parseLines(rows, 0, detectColumns(rows[0]), "positive_is_out");
    expect(res.lines[0]).toMatchObject({ direction: "out", cents: 2000 });
  });

  it("works on a real .xlsx file with Excel dates", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Date", "Description", "Amount"],
      [new Date(2026, 0, 15), "VERIZON WIRELESS", -80.25],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const back = XLSX.read(buf, { type: "array", cellDates: true });
    const rows = XLSX.utils.sheet_to_json<Cell[]>(back.Sheets.Sheet1, { header: 1, raw: true, defval: null });
    const res = parseLines(rows, 0, detectColumns(rows[0]));
    expect(res.lines[0]).toMatchObject({ date: "2026-01-15", cents: 8025, direction: "out" });
  });
});

describe("categorize", () => {
  it.each([
    ["SHELL OIL 57444", "out", "Car and truck expenses"],
    ["ADOBE *CREATIVE CLOUD", "out", "Software and subscriptions"],
    ["VERIZON WIRELESS", "out", "Telephone and internet"],
    ["STARBUCKS #1234", "out", "Meals"],
    ["ONLINE BANKING TRANSFER TO SAVINGS", "out", "Transfer between accounts"],
    ["AMAZON MKTPL*2X3", "out", "Needs review"],
    ["MONTHLY SERVICE CHARGE", "out", "Bank and merchant fees"],
    ["STRIPE TRANSFER ST-ABC", "in", "Sales / gross receipts"],
    ["INTEREST PAYMENT", "in", "Other business income"],
    ["SOMETHING UNKNOWN", "out", "Needs review"],
    // Rule-order regressions
    ["MONTHLY MAINTENANCE FEE", "out", "Bank and merchant fees"],
    ["MONTHLY SERVICE FEE", "out", "Bank and merchant fees"],
    ["ENTERPRISE RENT-A-CAR", "out", "Travel"],
    ["FRONTIER AIRLINES", "out", "Travel"],
    ["FRONTIER COMMUNICATIONS", "out", "Telephone and internet"],
    ["UBER EATS ORDER", "out", "Meals"],
    ["UBER TRIP", "out", "Travel"],
    ["AMAZON WEB SERVICES", "out", "Software and subscriptions"],
    ["SPIRIT HALLOWEEN", "out", "Needs review"],
    ["SPIRIT AIRLINES", "out", "Travel"],
    ["ADOBE LICENSE", "out", "Software and subscriptions"],
    ["DMV LICENSE RENEWAL", "out", "Taxes and licenses"],
    ["OFFICE RENT JANUARY", "out", "Rent or lease: business property"],
    ["HVAC REPAIR", "out", "Repairs and maintenance"],
  ] as const)("%s (%s) -> %s", (desc, dir, cat) => {
    expect(categorize(desc, dir).category).toBe(cat);
  });

  it("only ever returns known categories", () => {
    for (const d of ["x", "shell", "stripe", "irs", "atm", "refund", "loan", "uber", "rent"]) {
      for (const dir of ["in", "out"] as const) expect(ALL_CATEGORY_NAMES).toContain(categorize(d, dir).category);
    }
  });
});
