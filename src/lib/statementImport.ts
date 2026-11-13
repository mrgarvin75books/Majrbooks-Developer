/**
 * Reads bank-statement spreadsheets (Excel / CSV) without AI.
 *
 * The sheet is read as rows of cells. We find the header row, guess which
 * columns hold the date, description and amount (single signed amount, or
 * separate debit / credit columns), and turn each data row into a line with
 * a positive amount in cents and a direction ("in" = money received,
 * "out" = money paid). All money is handled as integer cents.
 */
import type { Cents } from "./money";

export type Cell = string | number | boolean | Date | null | undefined;

export interface ColumnMapping {
  date: number | null;
  description: number | null;
  /** A single signed amount column. */
  amount: number | null;
  /** Money out (withdrawals / debits). */
  debit: number | null;
  /** Money in (deposits / credits). */
  credit: number | null;
  /**
   * Optional bookkeeper columns from a workbook that is already categorised
   * (e.g. "Sch C Line", "Schedule C Treatment", "Part V Detail",
   * "Include on Sch C? (Y/N)"). When present, they set each line's category
   * instead of the built-in rules. See sheetCategories.ts.
   */
  category?: number | null;
  treatment?: number | null;
  detail?: number | null;
  include?: number | null;
  /**
   * Optional column saying which way the money moved ("Income"/"Expense",
   * "Credit"/"Debit", "In"/"Out"). Used only when the amount column has no
   * negative numbers, i.e. the sheet shows every amount as positive.
   */
  direction?: number | null;
}

/** Reads a direction cell: Income/Credit/Deposit/In → "in"; Expense/Debit/Withdrawal/Out → "out". */
export function parseDirectionCell(value: Cell): "in" | "out" | null {
  const s = String(value ?? "").trim().toLowerCase();
  if (/^(income|credit|cr|deposit|in|money in|receipt|revenue|sale)s?\b/.test(s)) return "in";
  if (/^(expense|debit|dr|withdrawal|out|money out|payment|purchase|charge)s?\b/.test(s)) return "out";
  return null;
}

/** Raw category text read from the sheet's bookkeeper columns. */
export interface SheetCategoryCells {
  category?: string;
  treatment?: string;
  detail?: string;
  include?: string;
}

/** How a single amount column is signed. Most banks: negative = money out. */
export type SignConvention = "negative_is_out" | "positive_is_out";

export interface ParsedLine {
  /** 1-based row number in the sheet, for error messages. */
  row: number;
  date: string; // YYYY-MM-DD
  description: string;
  cents: Cents; // always > 0
  direction: "in" | "out";
  /** Category cells from the sheet, when the mapping names category columns. */
  sheet?: SheetCategoryCells;
}

export interface ParseResult {
  lines: ParsedLine[];
  errors: { row: number; reason: string }[];
  skipped: number;
  /** Rows with a date but a $0.00 amount (left out; also counted in `skipped`). */
  zeroAmount?: number;
}

const norm = (v: Cell) => String(v ?? "").trim().toLowerCase();

const HEADER_PATTERNS = {
  date: /^(transaction |trans\.? |posting |posted |post |value |effective )?date$|^date |date$|^posted on$/,
  description: /desc|memo|payee|details|narrative|merchant|name|particulars|reference|transaction$/,
  /** Columns that are clearly the description; preferred over weaker matches like "Details" (Chase: DEBIT/CREDIT). */
  descriptionStrong: /desc|memo|payee|narrative|merchant|^name$|payee name|merchant name/,
  amount: /^amount|amount$|^amt$|^value$|transaction amount|net amount/,
  debit: /debit|withdraw|money out|paid out|payments?$|^out$|charges?$|spent/,
  credit: /credit|deposit|money in|paid in|receipts?$|^in$|received/,
};

/** Finds the header row: the first of the top 25 rows that names a date and an amount/description column. */
export function findHeaderRow(rows: Cell[][]): number {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = (rows[i] ?? []).map(norm);
    const hasDate = cells.some((c) => HEADER_PATTERNS.date.test(c));
    const hasMoney = cells.some((c) => HEADER_PATTERNS.amount.test(c) || HEADER_PATTERNS.debit.test(c) || HEADER_PATTERNS.credit.test(c));
    if (hasDate && hasMoney) return i;
  }
  return 0;
}

export function detectColumns(header: Cell[]): ColumnMapping {
  const cells = header.map(norm);
  const find = (re: RegExp, exclude: number[] = []) => {
    const i = cells.findIndex((c, idx) => c && !exclude.includes(idx) && re.test(c) && !/balance/.test(c));
    return i >= 0 ? i : null;
  };
  const date = find(HEADER_PATTERNS.date);
  const debit = find(HEADER_PATTERNS.debit, [date ?? -1]);
  const credit = find(HEADER_PATTERNS.credit, [date ?? -1, debit ?? -1]);
  const amount = debit !== null && credit !== null ? null : find(HEADER_PATTERNS.amount, [date ?? -1]);
  const used = [date ?? -1, amount ?? -1, debit ?? -1, credit ?? -1];
  const description = find(HEADER_PATTERNS.descriptionStrong, used) ?? find(HEADER_PATTERNS.description, used);
  // Bookkeeper category columns. Only clearly Schedule C columns count: a
  // loose "Spending Category" (e.g. "Children & Family") isn't a tax category.
  const taken = [...used, description ?? -1];
  // A Schedule C line number column is the most precise; a category-name column
  // next to it is kept as the note ("Dues/subscriptions/entertainment").
  const lineCol = find(/^(sch(edule)?\.?\s*c\s*)?line( ?#| no\.?| number)?$/, taken);
  const nameCol = find(
    /^(sch(edule)?\.?\s*c|tax)\s*(category|line description)$|^schedule c category$|^category$|^category\s*\(\s*sch(edule)?\.?\s*c\s*\)$/,
    [...taken, lineCol ?? -1],
  );
  const category = lineCol ?? nameCol;
  const treatment = find(/^sch(edule)?\.?\s*c\s*treatment$|^treatment$/, [...taken, lineCol ?? -1, nameCol ?? -1]);
  const detail = find(/^part v detail|^other expense (type|detail)/, [...taken, lineCol ?? -1, nameCol ?? -1, treatment ?? -1])
    ?? (lineCol !== null ? nameCol : null);
  const include = find(/^include on sch(edule)?\.?\s*c/, [...taken, lineCol ?? -1, nameCol ?? -1, treatment ?? -1, detail ?? -1]);
  // "Type" / "Debit / Credit" / "Section": Income/Expense, Credit/Debit, In/Out.
  const directionCol = amount !== null
    ? find(/^(type|transaction type|txn type|debit\s*\/\s*credit|credit\s*\/\s*debit|dr\s*\/\s*cr|cr\s*\/\s*dr|direction|in\s*\/\s*out|section)$/,
      [...taken, category ?? -1, treatment ?? -1, detail ?? -1, include ?? -1])
    : null;

  return {
    date, description, amount,
    debit: amount === null ? debit : null,
    credit: amount === null ? credit : null,
    category, treatment, detail, include,
    direction: directionCol,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Parses a date cell into YYYY-MM-DD (US month-first when ambiguous). */
export function parseDateCell(value: Cell): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // SheetJS makes dates at local midnight, or UTC midnight for some files, or
    // local date + time when the cell has a time. Use whichever calendar day
    // the cell actually names; never shift a date-with-time to another day.
    const v = value;
    const localMidnight = v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0;
    const utcMidnight = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
    const [y, m, day] = !localMidnight && utcMidnight
      ? [v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()]
      : [v.getFullYear(), v.getMonth() + 1, v.getDate()];
    return validDate(y, m, day) ? iso(y, m, day) : null;
  }
  if (typeof value === "number") {
    // Excel serial date (days since 1899-12-30)
    if (value < 20000 || value > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(value).trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return validDate(y, mo, d) ? iso(y, mo, d) : null;
  }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[\sT]+\d{1,2}:\d{2}.*)?$/))) {
    const [a, b] = [+m[1], +m[2]];
    let y = +m[3];
    if (y < 100) y += 2000;
    // Month first (US), unless the first number can't be a month.
    const [mo, d] = a > 12 && b <= 12 ? [b, a] : [a, b];
    return validDate(y, mo, d) ? iso(y, mo, d) : null;
  }
  if ((m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})\.?[-\s,]+(\d{2,4})$/))) {
    const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    let y = +m[3];
    if (y < 100) y += 2000;
    return mo && validDate(y, mo, +m[1]) ? iso(y, mo, +m[1]) : null;
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo && validDate(+m[3], mo, +m[2]) ? iso(+m[3], mo, +m[2]) : null;
  }
  return null;
}

/**
 * Parses a money cell into signed cents. Accepts 1234.5, "$1,234.50",
 * "(12.00)", "-12", "12.00-", "12.00 CR", "12.00 DR". Returns null if empty
 * or not money.
 */
export function parseAmountCell(value: Cell): Cents | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : null;
  let s = String(value).trim().toUpperCase();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/\s*CR$/.test(s)) { s = s.replace(/\s*CR$/, ""); }
  if (/\s*DR$/.test(s)) { negative = true; s = s.replace(/\s*DR$/, ""); }
  if (s.endsWith("-")) { negative = true; s = s.slice(0, -1); }
  s = s.replace(/[$£€\s,]/g, "").replace(/^USD/, "");
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); }
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole || "0") * 100 + Number(frac.padEnd(2, "0") || "0");
  return negative ? -cents : cents;
}

export function parseLines(
  rows: Cell[][],
  headerRow: number,
  map: ColumnMapping,
  sign: SignConvention = "negative_is_out",
): ParseResult {
  const lines: ParsedLine[] = [];
  const errors: ParseResult["errors"] = [];
  let skipped = 0;
  let zeroAmount = 0;

  // A direction column decides in/out only when every amount is positive; when
  // the sheet signs its amounts, the sign wins (a refund on an "Expense" line
  // is still money in).
  const amountCol = map.amount;
  const useDirectionCol = amountCol !== null && map.direction != null
    && !rows.slice(headerRow + 1).some((r) => (parseAmountCell((r ?? [])[amountCol]) ?? 0) < 0);

  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const rowNo = i + 1;
    const rawDate = map.date !== null ? r[map.date] : null;
    const desc = map.description !== null ? String(r[map.description] ?? "").replace(/\s+/g, " ").trim() : "";

    let cents: number | null = null;
    let direction: "in" | "out" | null = null;
    let zero = false; // a $0.00 line: nothing to import
    if (map.amount !== null) {
      const v = parseAmountCell(r[map.amount]);
      if (v === 0) zero = true;
      if (v !== null && v !== 0) {
        const out = sign === "negative_is_out" ? v < 0 : v > 0;
        cents = Math.abs(v);
        direction = (useDirectionCol ? parseDirectionCell(r[map.direction!]) : null) ?? (out ? "out" : "in");
      }
    } else {
      const out = map.debit !== null ? parseAmountCell(r[map.debit]) : null;
      const inn = map.credit !== null ? parseAmountCell(r[map.credit]) : null;
      if (out && Math.abs(out) > 0 && !(inn && Math.abs(inn) > 0)) { cents = Math.abs(out); direction = "out"; }
      else if (inn && Math.abs(inn) > 0 && !(out && Math.abs(out) > 0)) { cents = Math.abs(inn); direction = "in"; }
      else if (inn && out) { errors.push({ row: rowNo, reason: "has both a debit and a credit" }); continue; }
      else if (out === 0 || inn === 0) zero = true;
    }

    const emptyRow = r.every((c) => c === null || c === undefined || String(c).trim() === "");
    if (emptyRow) { skipped++; continue; }
    // Opening/closing balance and total rows have no usable date or amount.
    if (/^(opening|closing|beginning|ending)?\s*balance|^total|^(transaction )?count\b|^reconcil|^difference\b/i.test(desc) &&(cents === null || rawDate === null || rawDate === "")) {
      skipped++;
      continue;
    }

    const date = parseDateCell(rawDate);
    // Rows with neither an amount nor a description carry nothing to import.
    if ((!date || !desc) && cents === null) { skipped++; continue; }
    if (!date) { errors.push({ row: rowNo, reason: `date "${String(rawDate ?? "")}" not recognised` }); continue; }
    if ((cents === null || direction === null) && zero) { skipped++; zeroAmount++; continue; }
    if (cents === null || direction === null) { errors.push({ row: rowNo, reason: "no amount" }); continue; }

    const line: ParsedLine = { row: rowNo, date, description: desc.slice(0, 500) || "(no description)", cents, direction };
    const cell = (i: number | null | undefined) => (i === null || i === undefined ? undefined : String(r[i] ?? "").trim() || undefined);
    const sheet: SheetCategoryCells = { category: cell(map.category), treatment: cell(map.treatment), detail: cell(map.detail), include: cell(map.include) };
    if (Object.values(sheet).some((v) => v !== undefined)) line.sheet = sheet;
    lines.push(line);
  }
  return { lines, errors, skipped, zeroAmount };
}

/**
 * Workbooks often hold summaries (P&L, totals by month) next to the actual
 * transaction list. Picks the sheet that reads as the most transactions with
 * the automatic header / column detection; on a tie, the one that already
 * carries Schedule C categories, then fewer unreadable rows, then the
 * earlier sheet. Returns null when no sheet yields
 * any transaction.
 */
export function pickTransactionSheet(sheets: { name: string; rows: Cell[][] }[]): { name: string; count: number } | null {
  let best: { name: string; count: number; categorised: number; errors: number } | null = null;
  for (const { name, rows } of sheets) {
    if (!rows.length) continue;
    const h = findHeaderRow(rows);
    const { lines, errors } = parseLines(rows, h, detectColumns(rows[h] ?? []));
    if (!lines.length) continue;
    const categorised = lines.filter((l) => l.sheet).length;
    const better = !best
      || lines.length > best.count
      || (lines.length === best.count && categorised > best.categorised)
      || (lines.length === best.count && categorised === best.categorised && errors.length < best.errors);
    if (better) best = { name, count: lines.length, categorised, errors: errors.length };
  }
  return best && { name: best.name, count: best.count };
}

const normDesc = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Stable keys so re-importing the same statement skips lines already saved.
 * Identical lines inside one file (two $4.50 coffees the same day) get an
 * occurrence number so both are kept.
 */
export function fingerprints(lines: ParsedLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = `${l.date}|${l.direction}|${l.cents}|${normDesc(l.description)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}|${n}`;
  });
}
