import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  centsToDecimalString,
  formatMoney,
  formatMoneyCompact,
  parseMoney,
  sumCents,
  validateJournalLines,
  type JournalLineInput,
} from "./money";

describe("parseMoney", () => {
  it.each([
    ["0", 0],
    ["12", 1200],
    ["12.5", 1250],
    ["12.05", 1205],
    ["$1,234.56", 123456],
    ["-3.07", -307],
    [".5", 50],
    [" 7.00 ", 700],
    [0.1, 10],
    [19.99, 1999],
  ])("parses %p as %p cents", (input, cents) => {
    expect(parseMoney(input)).toBe(cents);
  });

  it.each(["", "abc", "1.234", "1,23.00", "--1", "1e5", "12.3.4"])("rejects %p", (input) => {
    expect(parseMoney(input)).toBeNull();
  });

  it("rejects sub-cent numbers", () => {
    expect(parseMoney(1.005)).toBeNull();
  });

  it("round-trips any cents value through the decimal string format", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), (cents) => {
        expect(parseMoney(centsToDecimalString(cents))).toBe(cents);
      }),
    );
  });
});

describe("sumCents", () => {
  it("adds exactly where floats do not", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumCents([parseMoney("0.1")!, parseMoney("0.2")!])).toBe(parseMoney("0.3"));
  });

  it("is order-independent", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1e9, max: 1e9 }), { maxLength: 200 }), (xs) => {
        expect(sumCents([...xs].reverse())).toBe(sumCents(xs));
      }),
    );
  });

  it("rejects non-integer input", () => {
    expect(() => sumCents([1.5])).toThrow();
  });
});

describe("formatting", () => {
  it("formats exact amounts", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
    expect(formatMoney(-5)).toBe("-$0.05");
    expect(formatMoney(-123456, { parentheses: true })).toBe("($1,234.56)");
  });

  it("never shows small values in thousands (the $0.004k bug)", () => {
    expect(formatMoneyCompact(400)).toBe("$4");
    expect(formatMoneyCompact(123400)).toBe("$1,234");
    expect(formatMoneyCompact(999_999)).toBe("$10,000");
    expect(formatMoneyCompact(1_230_000)).toBe("$12.3k");
    expect(formatMoneyCompact(250_000_000)).toBe("$2.5M");
    expect(formatMoneyCompact(-1_230_000)).toBe("-$12.3k");
  });
});

// ---------------------------------------------------------------------------
// Journal entry validation (mirrors database rules V1 and V2)
// ---------------------------------------------------------------------------
const line = (account_id: string, debit: string, credit: string): JournalLineInput => ({ account_id, debit, credit });

describe("validateJournalLines", () => {
  it("accepts a balanced two-line entry", () => {
    const v = validateJournalLines([line("a", "100.10", ""), line("b", "", "100.10")]);
    expect(v.ok).toBe(true);
    expect(v.totalDebit).toBe(10010);
  });

  it("detects imbalance by one cent", () => {
    const v = validateJournalLines([line("a", "100.10", ""), line("b", "", "100.09")]);
    expect(v.ok).toBe(false);
    expect(v.difference).toBe(1);
  });

  it("rejects a line with both debit and credit", () => {
    const v = validateJournalLines([line("a", "5", "5"), line("b", "", "0")]);
    expect(v.ok).toBe(false);
  });

  it("requires accounts and at least two lines", () => {
    expect(validateJournalLines([line("a", "5", "")]).ok).toBe(false);
    expect(validateJournalLines([line("", "5", ""), line("b", "", "5")]).ok).toBe(false);
  });

  it("ignores blank rows", () => {
    const v = validateJournalLines([line("a", "1", ""), line("", "", ""), line("b", "", "1")]);
    expect(v.ok).toBe(true);
  });

  // Property: splitting any amount into random debit lines and offsetting it
  // with random credit lines always validates, and the totals are exact.
  it("any exact split into debits and credits balances", () => {
    const positiveCents = fc.integer({ min: 1, max: 10_000_000 });
    fc.assert(
      fc.property(
        fc.array(positiveCents, { minLength: 1, maxLength: 20 }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 20 }),
        (debitParts, creditWeights) => {
          const total = sumCents(debitParts);
          if (creditWeights.length > total) return; // can't give each credit line >= 1 cent
          const weightSum = creditWeights.reduce((a, b) => a + b, 0);
          const credits = creditWeights.map((w) => Math.max(1, Math.floor((total * w) / weightSum)));
          // put the rounding remainder on the first credit line
          credits[0] += total - sumCents(credits);
          if (credits[0] <= 0) return;

          const lines = [
            ...debitParts.map((d, i) => line(`d${i}`, centsToDecimalString(d), "")),
            ...credits.map((c, i) => line(`c${i}`, "", centsToDecimalString(c))),
          ];
          const v = validateJournalLines(lines);
          expect(v.errors).toEqual([]);
          expect(v.totalDebit).toBe(total);
          expect(v.totalCredit).toBe(total);
        },
      ),
    );
  });

  // Property: reversing an entry (swapping debits and credits) keeps it valid,
  // and original + reversal nets every account to zero.
  it("a reversal is valid and nets to zero with the original", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 1, max: 1e9 }), (a, b) => {
        const original = [line("x", centsToDecimalString(a + b), ""), line("y", "", centsToDecimalString(a)), line("z", "", centsToDecimalString(b))];
        const reversal = original.map((l) => line(l.account_id, l.credit, l.debit));
        expect(validateJournalLines(original).ok).toBe(true);
        expect(validateJournalLines(reversal).ok).toBe(true);

        const net = new Map<string, number>();
        for (const l of [...original, ...reversal]) {
          const delta = (parseMoney(l.debit || "0") ?? 0) - (parseMoney(l.credit || "0") ?? 0);
          net.set(l.account_id, (net.get(l.account_id) ?? 0) + delta);
        }
        for (const v of net.values()) expect(v).toBe(0);
      }),
    );
  });
});
