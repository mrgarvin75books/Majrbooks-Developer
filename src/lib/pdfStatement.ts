/**
 * Reads bank-statement PDFs without AI.
 *
 * Works on PDFs downloaded from online banking (they contain real text).
 * Scanned / photographed statements have no text and can't be read here.
 *
 * The page text is rebuilt into lines (by position), then each line that
 * starts with a date and ends with money amounts becomes a transaction.
 * Whether money went in or out is decided, in order of trust, by:
 *   1. the column the amount sits under ("Deposits" / "Withdrawals"),
 *   2. the section of the statement ("Deposits and additions", "Checks paid"…),
 *   3. the change in the running balance, when the statement prints one,
 *   4. the amount's sign (using the same convention as spreadsheets).
 */
import type { Cents } from "./money";
import { parseAmountCell, parseDateCell, type ParsedLine, type ParseResult, type SignConvention } from "./statementImport";

/** One run of text on a PDF page: its text, left x, baseline y (grows upward) and width. */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
}
export type PdfPage = PdfTextItem[];

export interface PdfParseResult extends ParseResult {
  /** True when no full date with a year was found, so the year was assumed. */
  yearGuessed: boolean;
  /** Lines whose in/out came only from the amount's sign. */
  signBased: number;
  /** "Total deposits…" / "Total withdrawals…" figures printed on the statement, when found. */
  statementTotals: { in: Cents | null; out: Cents | null };
}

interface Token { text: string; x: number; w: number }
interface Line { page: number; y: number; tokens: Token[]; text: string }

type Dir = "in" | "out";
type ColumnKind = Dir | "bal" | "amount";

/* ------------------------------------------------------------------ */
/* Reading the PDF                                                      */
/* ------------------------------------------------------------------ */

export class PdfReadError extends Error {}

/** Extracts positioned text from every page. Throws PdfReadError with a user-facing message. */
export async function extractPdfPages(data: ArrayBuffer): Promise<PdfPage[]> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const task = pdfjs.getDocument({ data: new Uint8Array(data) });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if ((e as { name?: string })?.name === "PasswordException") {
      throw new PdfReadError("This PDF is password-protected. Open it, save a copy without a password, and upload that.");
    }
    throw new PdfReadError("This PDF couldn't be opened. Try downloading the statement from the bank again.");
  }
  const pages: PdfPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items: PdfPage = [];
    for (const it of content.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width });
    }
    pages.push(items);
  }
  await task.destroy();
  if (pages.every((p) => p.length === 0)) {
    throw new PdfReadError(
      "This PDF has no readable text. It's probably a scan or photo. Download the statement from the bank's website (PDF, CSV or Excel) instead.",
    );
  }
  return pages;
}

/* ------------------------------------------------------------------ */
/* Rebuilding lines                                                     */
/* ------------------------------------------------------------------ */

/** Groups text items into lines (top to bottom) and splits them into word tokens with approximate x positions. */
export function buildLines(pages: PdfPage[]): Line[] {
  const out: Line[] = [];
  pages.forEach((items, pageIdx) => {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const groups: PdfTextItem[][] = [];
    for (const it of sorted) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(g[0].y - it.y) <= 3) g.push(it);
      else groups.push([it]);
    }
    for (const g of groups) {
      g.sort((a, b) => a.x - b.x);
      const tokens: Token[] = [];
      for (const it of g) {
        const perChar = it.str.length ? it.w / it.str.length : 0;
        const re = /\S+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(it.str))) {
          tokens.push({ text: m[0], x: it.x + m.index * perChar, w: m[0].length * perChar });
        }
      }
      if (tokens.length) out.push({ page: pageIdx + 1, y: g[0].y, tokens: mergeMoneyTokens(tokens), text: tokens.map((t) => t.text).join(" ") });
    }
  });
  return out;
}

const join = (a: Token, b: Token, sep = ""): Token => ({ text: a.text + sep + b.text, x: a.x, w: b.x + b.w - a.x });

/** Joins "$" + "12.00", "-" + "$12.00", "12.00" + "CR"/"DR"/"-" into single tokens. */
function mergeMoneyTokens(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    while (/^[-+(]?\$?$|^-\$$/.test(t.text) && i + 1 < tokens.length && /^[\d.(]/.test(tokens[i + 1].text)) {
      t = join(t, tokens[++i]);
    }
    if (isMoney(t.text) && i + 1 < tokens.length && /^(CR|DR|-)$/i.test(tokens[i + 1].text)) {
      t = join(t, tokens[++i], /^-$/.test(tokens[i].text) ? "" : " ");
    }
    out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Recognising pieces                                                   */
/* ------------------------------------------------------------------ */

/** Money with cents ("1,234.56", "$12.00", "(5.00)", "12.00-", "3.00 CR"). Whole numbers are not money here (check numbers, counts). */
export function isMoney(s: string): boolean {
  return /^[-+]?\(?[-+]?\$?\s?\d{1,3}(,\d{3})*\.\d{2}\)?-?(\s?(CR|DR))?$|^[-+]?\(?[-+]?\$?\s?\d+\.\d{2}\)?-?(\s?(CR|DR))?$/i.test(s);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface DateHit { month: number; day: number; year: number | null; used: number }

/** Reads a date at tokens[i]: "01/15", "1-15", "01/15/26", "01/15/2026", "Jan 15", "Jan 15, 2026", "15 Jan". */
function readDate(tokens: Token[], i: number): DateHit | null {
  const a = tokens[i]?.text.replace(/[,.]$/, "");
  if (!a) return null;
  const m = a.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
  if (m) {
    const month = +m[1], day = +m[2];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    return { month, day, year, used: 1 };
  }
  const mon = (s: string | undefined) => (s ? MONTHS[s.slice(0, 3).toLowerCase()] ?? null : null);
  const b = tokens[i + 1]?.text.replace(/[,.]$/, "");
  if (/^[A-Za-z]{3,9}\.?$/.test(a) && mon(a) && b && /^\d{1,2}$/.test(b)) {
    const c = tokens[i + 2]?.text;
    const year = c && /^\d{4}$/.test(c) ? +c : null;
    return { month: mon(a)!, day: +b, year, used: year ? 3 : 2 };
  }
  if (/^\d{1,2}$/.test(a) && b && /^[A-Za-z]{3,9}\.?$/.test(b) && mon(b)) {
    const c = tokens[i + 2]?.text;
    const year = c && /^\d{4}$/.test(c) ? +c : null;
    return { month: mon(b)!, day: +a, year, used: year ? 3 : 2 };
  }
  return null;
}

const IN_SECTION = /^(deposits?|credits?|additions?|other credits|electronic deposits|atm (and|&) electronic deposits|interest (paid|earned)|payments?,? (and )?(other )?credits)\b/;
const OUT_SECTION = /^(withdrawals?|debits?|checks?|electronic (withdrawals|payments)|other (withdrawals|debits|subtractions)|atm (and|&) debit card (withdrawals|subtractions)|card (purchases|transactions|withdrawals)|purchases|(service )?fees|fees charged|subtractions|other subtractions|payments? (made|sent)|purchases and adjustments)\b/;
const SKIP_SECTION = /daily (ending |ledger )?balance|ledger balances?|balance summary|account summary|checking summary|savings summary|interest summary|year[- ]to[- ]date|totals for this period/;
const OPENING = /^(beginning|opening|previous|starting|prior) (statement )?balance|^balance (forward|brought forward|last statement)/;
const CLOSING = /^(ending|closing|new) (statement )?balance/;

/* ------------------------------------------------------------------ */
/* Parsing                                                              */
/* ------------------------------------------------------------------ */

/** Latest full date (with a year) printed anywhere on the statement, as [year, month]. */
function statementEnd(lines: Line[]): { year: number; month: number } | null {
  let best: { year: number; month: number; key: number } | null = null;
  for (const l of lines) {
    for (let i = 0; i < l.tokens.length; i++) {
      const d = readDate(l.tokens, i);
      if (!d || d.year === null || d.year < 1990 || d.year > 2100) continue;
      const key = d.year * 100 + d.month;
      if (!best || key > best.key) best = { year: d.year, month: d.month, key };
    }
  }
  return best && { year: best.year, month: best.month };
}

export function parsePdfStatement(pages: PdfPage[], sign: SignConvention = "negative_is_out", today = new Date()): PdfParseResult {
  const lines = buildLines(pages);
  const end = statementEnd(lines);
  const yearGuessed = end === null;
  const endYear = end?.year ?? today.getFullYear();
  const endMonth = end?.month ?? 12;

  const result: PdfParseResult = { lines: [], errors: [], skipped: 0, yearGuessed, signBased: 0, statementTotals: { in: null, out: null } };
  const totalsSeen = { in: new Set<number>(), out: new Set<number>() };

  let section: Dir | "skip" | null = null;
  let columns: { kind: ColumnKind; x: number }[] = [];
  let balance: number | null = null; // running balance in signed cents
  let last: { line: ParsedLine; page: number; y: number; descX: number; extra: number } | null = null;
  let rowNo = 0;

  for (const line of lines) {
    const toks = line.tokens;
    const lower = line.text.toLowerCase();

    // Trailing run of money tokens = the amounts on this line.
    let firstMoney = toks.length;
    while (firstMoney > 0 && isMoney(toks[firstMoney - 1].text)) firstMoney--;
    const amounts = toks.slice(firstMoney);

    // Continuation of the previous transaction's description (indented, right below it, no amounts).
    if (last && !amounts.length && !readDate(toks, 0) && line.page === last.page && last.y - line.y < 20 && toks[0].x >= last.descX - 4 && last.extra < 2) {
      last.line.description = `${last.line.description} ${line.text}`.slice(0, 500);
      last.extra++;
      last.y = line.y;
      continue;
    }

    // Column header row ("Date  Description  Deposits  Withdrawals  Balance").
    if (!amounts.length && /\b(date|description)\b/.test(lower)) {
      const cols: { kind: ColumnKind; x: number }[] = [];
      for (const t of toks) {
        const s = t.text.toLowerCase();
        const kind: ColumnKind | null =
          /^(deposits?|credits?|additions?|money ?in|paid ?in)\b/.test(s) ? "in"
          : /^(withdrawals?|debits?|subtractions?|payments?|charges?|money ?out|paid ?out)\b/.test(s) ? "out"
          : /^balance/.test(s) ? "bal"
          : /^amount/.test(s) ? "amount"
          : null;
        if (kind && !cols.some((c) => c.kind === kind)) cols.push({ kind, x: t.x + t.w / 2 });
      }
      if (cols.length) { columns = cols; last = null; continue; }
    }

    // Section headings: short lines with no amounts.
    const heading = lower.replace(/[^a-z&,\s-]/g, " ").replace(/\s+/g, " ").trim();
    if (!amounts.length && heading.length <= 70 && !/^total\b/.test(heading)) {
      if (SKIP_SECTION.test(heading)) { section = "skip"; last = null; continue; }
      if (IN_SECTION.test(heading)) { section = "in"; last = null; continue; }
      if (OUT_SECTION.test(heading)) { section = "out"; last = null; continue; }
    }

    // Printed totals, used to double-check what we read.
    if (/^total\b/.test(heading) && amounts.length) {
      const v = Math.abs(parseAmountCell(amounts[amounts.length - 1].text) ?? 0);
      const dir: Dir | null = IN_SECTION.test(heading.replace(/^total\s+/, "")) ? "in" : OUT_SECTION.test(heading.replace(/^total\s+/, "")) ? "out" : null;
      if (dir && v && !totalsSeen[dir].has(v)) {
        totalsSeen[dir].add(v);
        result.statementTotals[dir] = (result.statementTotals[dir] ?? 0) + v;
      }
      last = null;
      continue;
    }

    // Find the date: first token, or second when a check number comes first.
    let dateAt = 0;
    let checkNo: string | null = null;
    let date = readDate(toks, 0);
    if (!date && /^\d{3,6}\*?\^?$/.test(toks[0]?.text ?? "")) {
      // "1234 ^ 01/05 Check 100.00" (check number, optional marker, then date)
      for (let j = 1; j <= 2 && !date; j++) {
        date = readDate(toks, j);
        if (date) { dateAt = j; checkNo = toks[0].text.replace(/\D/g, ""); }
      }
    }

    if (!date) {
      // "Beginning balance $1,000.00" starts the running balance.
      if (amounts.length && OPENING.test(heading)) balance = parseAmountCell(amounts[amounts.length - 1].text);
      last = null;
      continue;
    }
    last = null;

    let descStart = dateAt + date.used;
    // A second date right after (posting date) is not part of the description.
    const second = readDate(toks, descStart);
    if (second && descStart < firstMoney) descStart += second.used;
    const descTokens = toks.slice(descStart, firstMoney);
    let description = descTokens.map((t) => t.text).join(" ").replace(/\s+/g, " ").trim();
    if (checkNo) description = `Check ${checkNo}${description ? ` ${description}` : ""}`;
    const descLower = description.toLowerCase();

    if (section === "skip") { result.skipped++; continue; }

    if (OPENING.test(descLower)) {
      if (amounts.length) balance = parseAmountCell(amounts[amounts.length - 1].text);
      result.skipped++;
      continue;
    }
    if (CLOSING.test(descLower)) { result.skipped++; continue; }

    if (!amounts.length) { last = null; result.skipped++; continue; }

    rowNo++;
    const year = date.year ?? (date.month > endMonth ? endYear - 1 : endYear);
    const iso = parseDateCell(`${date.month}/${date.day}/${year}`);
    if (!iso) {
      result.errors.push({ row: 0, reason: `page ${line.page}: date "${toks.slice(dateAt, dateAt + date.used).map((t) => t.text).join(" ")}" not recognised` });
      continue;
    }

    // Work out which amount is the transaction and which way it went.
    let amountTok: Token | null = null;
    let direction: Dir | null = null;
    let balTok: Token | null = null;

    if (columns.length) {
      for (const a of amounts) {
        const cx = a.x + a.w / 2;
        const col = columns.reduce((best, c) => (Math.abs(c.x - cx) < Math.abs(best.x - cx) ? c : best));
        if (col.kind === "bal") balTok = a;
        else if (!amountTok) {
          amountTok = a;
          if (col.kind === "in" || col.kind === "out") direction = col.kind;
        }
      }
    }
    if (!amountTok) {
      amountTok = amounts[0];
      if (amounts.length >= 2) balTok = amounts[amounts.length - 1];
    }

    const signed = parseAmountCell(amountTok.text);
    if (signed === null || signed === 0) { result.skipped++; continue; }
    const cents = Math.abs(signed);

    if (!direction && (section === "in" || section === "out")) direction = section;

    const newBalance = balTok ? parseAmountCell(balTok.text) : null;
    if (!direction && balance !== null && newBalance !== null) {
      if (newBalance - balance === cents) direction = "in";
      else if (balance - newBalance === cents) direction = "out";
    }
    if (newBalance !== null) balance = newBalance;

    if (!direction) {
      result.signBased++;
      const out = sign === "negative_is_out" ? signed < 0 : signed > 0;
      direction = out ? "out" : "in";
    }

    const parsed: ParsedLine = { row: rowNo, date: iso, description: description.slice(0, 500) || "(no description)", cents, direction };
    result.lines.push(parsed);
    last = { line: parsed, page: line.page, y: line.y, descX: descTokens[0]?.x ?? toks[descStart - 1].x + 1, extra: 0 };
  }
  return result;
}
