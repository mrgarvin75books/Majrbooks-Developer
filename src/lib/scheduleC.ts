/**
 * Schedule C (Form 1040) categories, line mapping and totals.
 *
 * The AI only reads and categorises transactions; every total here is
 * computed in integer cents so arithmetic can never be "AI-estimated".
 * Tax mappings are a starting point and must be reviewed by a qualified
 * professional before filing.
 */
import { parseMoney, sumCents, type Cents } from "./money";

export type TxType = "income" | "expense" | "transfer" | "personal" | "needs_review";

export interface ScheduleCTransaction {
  date: string;
  description: string;
  /** Always positive; direction comes from `type`. */
  amount: number;
  category: string;
  type: TxType;
  notes: string;
}

export type CategoryKind = "income" | "cogs" | "expense";

export interface CategoryDef {
  name: string;
  kind: CategoryKind;
  /** Schedule C line, e.g. "8", "24b", "27a". */
  line: string;
  lineLabel: string;
  /** Share of the amount that is deductible on the form (meals: 0.5). */
  deductibleShare?: number;
}

/** The categories the AI must choose from (kept in sync with the edge function). */
export const CATEGORIES: CategoryDef[] = [
  { name: "Sales / gross receipts", kind: "income", line: "1", lineLabel: "Gross receipts or sales" },
  { name: "Other business income", kind: "income", line: "6", lineLabel: "Other income" },
  { name: "Cost of goods sold", kind: "cogs", line: "4", lineLabel: "Cost of goods sold" },
  { name: "Advertising", kind: "expense", line: "8", lineLabel: "Advertising" },
  { name: "Car and truck expenses", kind: "expense", line: "9", lineLabel: "Car and truck expenses" },
  { name: "Commissions and fees", kind: "expense", line: "10", lineLabel: "Commissions and fees" },
  { name: "Contract labor", kind: "expense", line: "11", lineLabel: "Contract labor" },
  { name: "Depreciation", kind: "expense", line: "13", lineLabel: "Depreciation and section 179" },
  { name: "Employee benefit programs", kind: "expense", line: "14", lineLabel: "Employee benefit programs" },
  { name: "Insurance (other than health)", kind: "expense", line: "15", lineLabel: "Insurance (other than health)" },
  { name: "Mortgage interest", kind: "expense", line: "16a", lineLabel: "Interest: mortgage (paid to banks, etc.)" },
  { name: "Other interest", kind: "expense", line: "16b", lineLabel: "Interest: other" },
  { name: "Legal and professional services", kind: "expense", line: "17", lineLabel: "Legal and professional services" },
  { name: "Office expense", kind: "expense", line: "18", lineLabel: "Office expense" },
  { name: "Pension and profit-sharing plans", kind: "expense", line: "19", lineLabel: "Pension and profit-sharing plans" },
  { name: "Rent or lease: vehicles and equipment", kind: "expense", line: "20a", lineLabel: "Rent or lease: vehicles, machinery, equipment" },
  { name: "Rent or lease: business property", kind: "expense", line: "20b", lineLabel: "Rent or lease: other business property" },
  { name: "Repairs and maintenance", kind: "expense", line: "21", lineLabel: "Repairs and maintenance" },
  { name: "Supplies", kind: "expense", line: "22", lineLabel: "Supplies" },
  { name: "Taxes and licenses", kind: "expense", line: "23", lineLabel: "Taxes and licenses" },
  { name: "Travel", kind: "expense", line: "24a", lineLabel: "Travel" },
  { name: "Meals", kind: "expense", line: "24b", lineLabel: "Deductible meals (50%)", deductibleShare: 0.5 },
  { name: "Utilities", kind: "expense", line: "25", lineLabel: "Utilities" },
  { name: "Wages", kind: "expense", line: "26", lineLabel: "Wages" },
  { name: "Software and subscriptions", kind: "expense", line: "27a", lineLabel: "Other expenses" },
  { name: "Bank and merchant fees", kind: "expense", line: "27a", lineLabel: "Other expenses" },
  { name: "Telephone and internet", kind: "expense", line: "27a", lineLabel: "Other expenses" },
  { name: "Postage and shipping", kind: "expense", line: "27a", lineLabel: "Other expenses" },
  { name: "Education and training", kind: "expense", line: "27a", lineLabel: "Other expenses" },
  { name: "Other expenses", kind: "expense", line: "27a", lineLabel: "Other expenses" },
];

export const NON_BUSINESS_CATEGORIES = ["Transfer between accounts", "Owner draw or personal", "Needs review"];

export const ALL_CATEGORY_NAMES = [...CATEGORIES.map((c) => c.name), ...NON_BUSINESS_CATEGORIES];

const BY_NAME = new Map(CATEGORIES.map((c) => [c.name.toLowerCase(), c]));

/**
 * Finds the category definition, also for reports saved before the
 * categories were standardised (fuzzy match on older names).
 */
export function categoryFor(name: string): CategoryDef | null {
  const key = (name ?? "").trim().toLowerCase();
  const exact = BY_NAME.get(key);
  if (exact) return exact;
  const rules: [RegExp, string][] = [
    [/advertis|marketing/, "Advertising"],
    [/car|truck|vehicle|fuel|gas\b/, "Car and truck expenses"],
    [/commission/, "Commissions and fees"],
    [/contract/, "Contract labor"],
    [/insurance/, "Insurance (other than health)"],
    [/legal|professional|accounting/, "Legal and professional services"],
    [/office/, "Office expense"],
    [/rent|lease/, "Rent or lease: business property"],
    [/repair|maintenance/, "Repairs and maintenance"],
    [/suppl/, "Supplies"],
    [/tax|licen/, "Taxes and licenses"],
    [/travel/, "Travel"],
    [/meal|entertain/, "Meals"],
    [/utilit/, "Utilities"],
    [/wage|payroll/, "Wages"],
    [/software|subscription/, "Software and subscriptions"],
    [/bank|fee/, "Bank and merchant fees"],
  ];
  for (const [re, target] of rules) if (re.test(key)) return BY_NAME.get(target.toLowerCase())!;
  return null;
}

const cents = (amount: number): Cents => Math.abs(parseMoney(Math.round(Number(amount) * 100) / 100) ?? 0);

export interface ScheduleCLine {
  line: string;
  label: string;
  amount: Cents;
}

export interface ScheduleCSummary {
  // Field names kept from the original report format (dollars, 2 decimals).
  total_income: number;
  expense_totals: Record<string, number>;
  total_expenses: number;
  net_profit: number;
  // Profit and loss (cents)
  pnl: {
    income: { category: string; amount: Cents }[];
    totalIncome: Cents;
    cogs: Cents;
    grossProfit: Cents;
    expenses: { category: string; amount: Cents }[];
    totalExpenses: Cents;
    netProfit: Cents;
  };
  // Schedule C form (cents)
  scheduleC: {
    line1GrossReceipts: Cents;
    line4Cogs: Cents;
    line5GrossProfit: Cents;
    line6OtherIncome: Cents;
    line7GrossIncome: Cents;
    expenseLines: ScheduleCLine[];
    otherExpenseDetail: { category: string; amount: Cents }[];
    line28TotalExpenses: Cents;
    line31NetProfit: Cents;
  };
  excluded: { transfers: Cents; personal: Cents; needsReview: Cents; needsReviewCount: number; uncategorized: number };
}

/** Line order as printed on the form. */
const LINE_ORDER = ["8", "9", "10", "11", "12", "13", "14", "15", "16a", "16b", "17", "18", "19", "20a", "20b", "21", "22", "23", "24a", "24b", "25", "26", "27a"];

export function computeSummary(transactions: ScheduleCTransaction[]): ScheduleCSummary {
  const incomeBy = new Map<string, Cents>();
  const expenseBy = new Map<string, Cents>();
  const lineAmounts = new Map<string, Cents>();
  const otherDetail = new Map<string, Cents>();
  let cogs = 0;
  let line1 = 0;
  let line6 = 0;
  const excluded = { transfers: 0, personal: 0, needsReview: 0, needsReviewCount: 0, uncategorized: 0 };
  const add = (m: Map<string, Cents>, k: string, v: Cents) => m.set(k, (m.get(k) ?? 0) + v);

  for (const tx of transactions) {
    const amt = cents(tx.amount);
    if (tx.type === "transfer") { excluded.transfers += amt; continue; }
    if (tx.type === "personal") { excluded.personal += amt; continue; }
    if (tx.type === "needs_review") { excluded.needsReview += amt; excluded.needsReviewCount++; continue; }

    const def = categoryFor(tx.category);
    if (tx.type === "income") {
      const name = def?.kind === "income" ? def.name : "Sales / gross receipts";
      add(incomeBy, name, amt);
      if (name === "Other business income") line6 += amt; else line1 += amt;
      continue;
    }
    // expense
    if (def?.kind === "cogs") { cogs += amt; continue; }
    const expDef = def && def.kind === "expense" ? def : null;
    if (!expDef) excluded.uncategorized++;
    const label = expDef?.name ?? (tx.category?.trim() || "Other expenses");
    add(expenseBy, label, amt);
    const line = expDef?.line ?? "27a";
    const deductible = expDef?.deductibleShare != null ? Math.round(amt * expDef.deductibleShare) : amt;
    add(lineAmounts, line, deductible);
    if (line === "27a") add(otherDetail, label, deductible);
  }

  const sortDesc = (m: Map<string, Cents>) =>
    [...m.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));

  const totalIncome = line1 + line6;
  const totalExpenses = sumCents(expenseBy.values());
  const grossProfit = totalIncome - cogs;
  const netProfit = grossProfit - totalExpenses;

  const labelFor = (line: string) => CATEGORIES.find((c) => c.line === line)?.lineLabel ?? "Other expenses";
  const expenseLines = LINE_ORDER.filter((l) => lineAmounts.has(l)).map((l) => ({ line: l, label: labelFor(l), amount: lineAmounts.get(l)! }));
  const line28 = sumCents(lineAmounts.values());
  const line5 = line1 - cogs;
  const line7 = line5 + line6;

  const toDollars = (c: Cents) => c / 100;
  return {
    total_income: toDollars(totalIncome),
    expense_totals: Object.fromEntries(sortDesc(expenseBy).map((e) => [e.category, toDollars(e.amount)])),
    total_expenses: toDollars(totalExpenses + cogs),
    net_profit: toDollars(netProfit),
    pnl: {
      income: sortDesc(incomeBy),
      totalIncome,
      cogs,
      grossProfit,
      expenses: sortDesc(expenseBy),
      totalExpenses,
      netProfit,
    },
    scheduleC: {
      line1GrossReceipts: line1,
      line4Cogs: cogs,
      line5GrossProfit: line5,
      line6OtherIncome: line6,
      line7GrossIncome: line7,
      expenseLines,
      otherExpenseDetail: sortDesc(otherDetail),
      line28TotalExpenses: line28,
      line31NetProfit: line7 - line28,
    },
    excluded,
  };
}

/** Normalises transactions from the AI or an older saved report. */
export function normalizeTransactions(raw: unknown): ScheduleCTransaction[] {
  if (!Array.isArray(raw)) return [];
  const types: TxType[] = ["income", "expense", "transfer", "personal", "needs_review"];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => {
      const amountNum = Number(t.amount);
      let type = String(t.type ?? "").toLowerCase().replace(/\s+/g, "_") as TxType;
      if (!types.includes(type)) type = Number.isFinite(amountNum) && amountNum > 0 ? "income" : "expense";
      return {
        date: String(t.date ?? ""),
        description: String(t.description ?? ""),
        amount: Number.isFinite(amountNum) ? Math.round(Math.abs(amountNum) * 100) / 100 : 0,
        category: String(t.category ?? (type === "needs_review" ? "Needs review" : "Other expenses")),
        type,
        notes: String(t.notes ?? ""),
      };
    });
}
