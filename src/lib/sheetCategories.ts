/**
 * Uses the categories a bookkeeper already put in a workbook (no AI).
 *
 * Reads a Schedule C line ("9", "24b", "27a") or a category name, plus an
 * optional treatment ("Excluded - Owner transfer in", "Expense offset
 * (refund)"), include flag (Y/N) and Part V detail, and turns them into the
 * app's own type + category. Returns null when the cells don't say anything
 * usable, so the caller falls back to the built-in rules.
 */
import type { Categorized } from "./categorizeRules";
import { CATEGORIES, categoryFor } from "./scheduleC";
import type { SheetCategoryCells } from "./statementImport";

/** Schedule C line → category. Line 27a (and Part V's line 48) is "Other expenses". */
const BY_LINE = new Map<string, string>();
for (const c of CATEGORIES) if (!BY_LINE.has(c.line) && c.line !== "27a") BY_LINE.set(c.line, c.name);
BY_LINE.set("27a", "Other expenses");
BY_LINE.set("27", "Other expenses");
BY_LINE.set("48", "Other expenses");
BY_LINE.set("16", "Other interest");
BY_LINE.set("20", "Rent or lease: business property");
BY_LINE.set("24", "Travel");

const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ").slice(0, 1000);

/**
 * A refund (money in) on an expense line stays an expense; the Schedule C
 * totals net it against that line using the line's direction.
 */
export function sheetCategory(cells: SheetCategoryCells | undefined): Categorized | null {
  if (!cells) return null;
  const treatment = cells.treatment ?? "";
  const excluded = /^excluded|^exclude\b|not on sch(edule)?\.? ?c|^personal\b/i.test(treatment) || /^n(o)?$/i.test(cells.include ?? "");

  if (excluded) {
    const isTransfer = /transfer|owner contribution|between accounts|credit card payment/i.test(treatment);
    return isTransfer
      ? { type: "transfer", category: "Transfer between accounts", notes: join(treatment) }
      : { type: "personal", category: "Owner draw or personal", notes: join(treatment || "Not on Schedule C (per workbook)") };
  }

  const raw = (cells.category ?? "").trim();
  if (!raw) return null;

  // A Schedule C line number ("9", "24b", "Line 27a", "Line 27a – Other: bank fees")…
  const lineMatch = raw.toLowerCase().replace(/\.0+$/, "").match(/^(?:line\s*)?(\d{1,2}[ab]?)(?=$|\s|[–—:-])/);
  let name = lineMatch ? BY_LINE.get(lineMatch[1]) ?? null : null;
  // …or a category / line description ("Utilities", "Gross receipts – Medicaid").
  if (!name) {
    if (/^other expenses?\b/i.test(raw)) name = "Other expenses";
    else if (/^(gross receipts|sales)\b/i.test(raw)) name = "Sales / gross receipts";
    else if (/^other (business )?income\b/i.test(raw)) name = "Other business income";
    else if (/^cost of goods/i.test(raw)) name = "Cost of goods sold";
    else name = categoryFor(raw)?.name ?? null;
  }
  if (!name) return null;

  // Keep the workbook's own label ("Other: bank fees", "Medicaid claims") as the note.
  const label = raw.includes("–") || raw.includes("—") || / - /.test(raw) ? raw : undefined;
  const def = categoryFor(name);
  const type = def?.kind === "income" ? "income" : "expense";
  return { type, category: name, notes: join(cells.detail ?? label, treatment && !/^(expense|income)$/i.test(treatment) ? treatment : undefined) };
}
