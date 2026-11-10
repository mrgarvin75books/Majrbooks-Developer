import { describe, expect, it } from "vitest";
import { isMoney, parsePdfStatement, type PdfPage } from "./pdfStatement";

/** Builds a page from rows of [x, text] cells; each row is one line, top to bottom. Text width ≈ 5pt per char. */
function page(rows: [number, string][][]): PdfPage {
  return rows.flatMap((cells, i) => cells.map(([x, str]) => ({ str, x, y: 700 - i * 12, w: str.length * 5 })));
}

const brief = (r: ReturnType<typeof parsePdfStatement>) =>
  r.lines.map((l) => `${l.date} ${l.direction} ${l.cents} ${l.description}`);

describe("isMoney", () => {
  it.each(["1,234.56", "$12.00", "(5.00)", "12.00-", "-$3.10", "3.00 CR", "0.99"])("accepts %p", (s) => expect(isMoney(s)).toBe(true));
  it.each(["1234", "01/15", "12.5", "abc", "1.234"])("rejects %p", (s) => expect(isMoney(s)).toBe(false));
});

describe("parsePdfStatement", () => {
  it("reads a section-style statement (deposits / withdrawals / checks), skipping summaries and daily balances", () => {
    const r = parsePdfStatement([
      page([
        [[40, "January 1, 2026 through January 31, 2026"]],
        [[40, "CHECKING SUMMARY"]],
        [[40, "Beginning Balance"], [400, "$1,000.00"]],
        [[40, "Deposits and Additions"], [300, "2"], [400, "1,500.00"]],
        [[40, "DEPOSITS AND ADDITIONS"]],
        [[40, "DATE"], [90, "DESCRIPTION"], [400, "AMOUNT"]],
        [[40, "01/05"], [90, "Client Payment Acme LLC"], [400, "$1,200.00"]],
        [[40, "01/20"], [90, "Zelle From J Smith"], [400, "300.00"]],
        [[40, "Total Deposits and Additions"], [400, "$1,500.00"]],
        [[40, "CHECKS PAID"]],
        [[40, "CHECK NO."], [90, "DATE PAID"], [400, "AMOUNT"]],
        [[40, "1001"], [70, "^"], [90, "01/08"], [400, "$250.00"]],
        [[40, "ELECTRONIC WITHDRAWALS"]],
        [[40, "01/10"], [90, "Card Purchase 01/09 Staples"], [400, "45.10"]],
        [[90, "Store 123 Austin TX"]],
        [[40, "01/12"], [90, "ATM Withdrawal"], [400, "-$100.00"]],
        [[40, "Total Electronic Withdrawals"], [400, "$145.10"]],
        [[40, "DAILY ENDING BALANCE"]],
        [[40, "01/05"], [100, "$2,200.00"], [200, "01/08"], [260, "$1,950.00"]],
      ]),
    ]);
    expect(brief(r)).toEqual([
      "2026-01-05 in 120000 Client Payment Acme LLC",
      "2026-01-20 in 30000 Zelle From J Smith",
      "2026-01-08 out 25000 Check 1001",
      "2026-01-10 out 4510 Card Purchase 01/09 Staples Store 123 Austin TX",
      "2026-01-12 out 10000 ATM Withdrawal",
    ]);
    expect(r.errors).toEqual([]);
    expect(r.yearGuessed).toBe(false);
    expect(r.signBased).toBe(0);
    expect(r.statementTotals).toEqual({ in: 150000, out: 14510 });
  });

  it("uses the Deposits / Withdrawals columns and ignores the balance column", () => {
    const r = parsePdfStatement([
      page([
        [[40, "Statement period 03/01/2026 - 03/31/2026"]],
        [[40, "Date"], [90, "Description"], [300, "Deposits/Credits"], [400, "Withdrawals/Debits"], [500, "Ending daily balance"]],
        [[40, "3/2"], [90, "Square Inc Deposit"], [300, "820.00"], [500, "1,820.00"]],
        [[40, "3/3"], [90, "Verizon Wireless Payment"], [405, "95.40"], [500, "1,724.60"]],
      ]),
    ]);
    expect(brief(r)).toEqual([
      "2026-03-02 in 82000 Square Inc Deposit",
      "2026-03-03 out 9540 Verizon Wireless Payment",
    ]);
  });

  it("works out in/out from the running balance when there are no sections or columns", () => {
    const r = parsePdfStatement([
      page([
        [[40, "Period ending Feb 28, 2026"]],
        [[40, "Beginning balance"], [400, "500.00"]],
        [[40, "02/03"], [90, "Payroll Deposit"], [300, "1,000.00"], [400, "1,500.00"]],
        [[40, "02/04"], [90, "Rent"], [300, "700.00"], [400, "800.00"]],
      ]),
    ]);
    expect(brief(r)).toEqual(["2026-02-03 in 100000 Payroll Deposit", "2026-02-04 out 70000 Rent"]);
    expect(r.signBased).toBe(0);
  });

  it("falls back to the sign, and the sign convention can be flipped", () => {
    const pages = [page([
      [[40, "Statement date 04/30/2026"]],
      [[40, "04/02"], [90, "Refund"], [400, "25.00"]],
      [[40, "04/03"], [90, "Coffee"], [400, "-4.50"]],
    ])];
    const a = parsePdfStatement(pages);
    expect(brief(a)).toEqual(["2026-04-02 in 2500 Refund", "2026-04-03 out 450 Coffee"]);
    expect(a.signBased).toBe(2);
    expect(brief(parsePdfStatement(pages, "positive_is_out"))).toEqual(["2026-04-02 out 2500 Refund", "2026-04-03 in 450 Coffee"]);
  });

  it("puts December lines of a Dec–Jan statement in the previous year", () => {
    const r = parsePdfStatement([page([
      [[40, "12/15/2026 to 01/14/2027"]],
      [[40, "WITHDRAWALS"]],
      [[40, "12/20"], [90, "Office Depot"], [400, "30.00"]],
      [[40, "01/02"], [90, "Adobe"], [400, "54.99"]],
    ])]);
    expect(r.lines.map((l) => l.date)).toEqual(["2026-12-20", "2027-01-02"]);
  });

  it("flags an assumed year when the statement prints none", () => {
    const r = parsePdfStatement([page([[[40, "DEPOSITS"]], [[40, "05/01"], [90, "Deposit"], [400, "10.00"]]])], "negative_is_out", new Date(2026, 6, 1));
    expect(r.yearGuessed).toBe(true);
    expect(r.lines[0].date).toBe("2026-05-01");
  });
});
