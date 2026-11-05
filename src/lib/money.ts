/**
 * Exact money arithmetic for the frontend.
 *
 * Amounts are handled as integer cents. Never add or compare dollar floats
 * (0.1 + 0.2 !== 0.3). Convert user input with parseMoney, do all math in
 * cents, and convert back with formatMoney / centsToDecimalString.
 */

export type Cents = number;

const MONEY_RE = /^\s*(-)?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{0,2}))?\s*$/;

/**
 * Parses user-entered money ("1,234.5", "$12", "-3.07") into integer cents.
 * Returns null for empty, malformed, or more-than-2-decimal input.
 */
export function parseMoney(input: string | number | null | undefined): Cents | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    const cents = Math.round(input * 100);
    // Reject numbers with sub-cent precision (e.g. 1.005)
    return Math.abs(cents / 100 - input) < 1e-9 ? cents : null;
  }
  const match = MONEY_RE.exec(input);
  if (!match) return null;
  const [, sign, whole, frac] = match;
  if (whole === undefined && (frac === undefined || frac === "")) return null;
  const dollars = Number((whole ?? "0").replace(/,/g, ""));
  const cents = Number((frac ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(dollars * 100 + cents)) return null;
  const value = dollars * 100 + cents;
  return sign ? -value : value;
}

/** Sums integer cents exactly. */
export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new Error(`Not an integer cents value: ${v}`);
    total += v;
  }
  return total;
}

/** "1234.50" — the format the database posting functions accept. */
export function centsToDecimalString(cents: Cents): string {
  if (!Number.isInteger(cents)) throw new Error(`Not an integer cents value: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Converts a database numeric (string or number, dollars) to cents. */
export function toCents(value: string | number | null | undefined): Cents {
  return parseMoney(value ?? 0) ?? 0;
}

/**
 * Display formatting. Accountant views show negatives in parentheses.
 */
export function formatMoney(cents: Cents, opts: { parentheses?: boolean } = {}): string {
  const abs = Math.abs(cents);
  const body = `$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  if (cents >= 0) return body;
  return opts.parentheses ? `(${body})` : `-${body}`;
}

/**
 * Compact formatting for charts and tiles (blueprint: "$1,234 under $10,000,
 * $12.3k above"). Fixes the "$0.004k" axis bug: small values are never
 * shown in thousands.
 */
export function formatMoneyCompact(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  if (dollars < 10_000) return `${sign}$${Math.round(dollars).toLocaleString("en-US")}`;
  if (dollars < 1_000_000) return `${sign}$${(dollars / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sign}$${(dollars / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export interface JournalLineInput {
  account_id: string;
  debit: string;
  credit: string;
  description?: string;
}

export interface JournalValidation {
  ok: boolean;
  totalDebit: Cents;
  totalCredit: Cents;
  difference: Cents;
  errors: string[];
}

/**
 * Mirrors the database posting rules V1/V2 so the form can explain problems
 * before submitting. The database remains the authority.
 */
export function validateJournalLines(lines: JournalLineInput[]): JournalValidation {
  const errors: string[] = [];
  const debits: Cents[] = [];
  const credits: Cents[] = [];
  const filled = lines.filter((l) => l.account_id || l.debit.trim() || l.credit.trim());

  if (filled.length < 2) errors.push("A journal entry needs at least two lines.");

  filled.forEach((line, i) => {
    const n = i + 1;
    const d = line.debit.trim() ? parseMoney(line.debit) : 0;
    const c = line.credit.trim() ? parseMoney(line.credit) : 0;
    if (d === null || c === null) {
      errors.push(`Line ${n}: enter amounts like 1234.56 (at most two decimals).`);
      return;
    }
    if (d < 0 || c < 0) errors.push(`Line ${n}: amounts cannot be negative.`);
    else if ((d > 0) === (c > 0)) errors.push(`Line ${n}: enter either a debit or a credit, not both.`);
    if (!line.account_id) errors.push(`Line ${n}: choose an account.`);
    debits.push(d);
    credits.push(c);
  });

  const totalDebit = sumCents(debits);
  const totalCredit = sumCents(credits);
  const difference = totalDebit - totalCredit;
  if (filled.length >= 2 && difference !== 0) errors.push("Total debits must equal total credits.");
  if (filled.length >= 2 && totalDebit === 0) errors.push("Enter at least one amount.");

  return { ok: errors.length === 0, totalDebit, totalCredit, difference, errors };
}
