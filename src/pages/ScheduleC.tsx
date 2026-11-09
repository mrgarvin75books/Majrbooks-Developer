import { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import { useSearchParams } from "react-router-dom";
import { detectColumns, findHeaderRow, parseLines, type Cell, type ParsedLine } from "@/lib/statementImport";
import { categorize } from "@/lib/categorizeRules";
import Layout from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Upload, FileText, AlertTriangle, DollarSign, TrendingUp, TrendingDown, RefreshCw, ClipboardList, X, File, Printer, CheckCircle2, Save, Loader2, FolderOpen, Calendar, Eye, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import {
  ALL_CATEGORY_NAMES, computeSummary, normalizeTransactions,
  type ScheduleCSummary, type ScheduleCTransaction, type TxType,
} from "@/lib/scheduleC";
import { formatMoney } from "@/lib/money";

type Transaction = ScheduleCTransaction;

const TX_TYPE_LABELS: Record<TxType, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
  personal: "Personal",
  needs_review: "Needs review",
};

interface FlaggedItem {
  date: string;
  description: string;
  amount: number;
  reason: string;
}

interface RecurringSub {
  description: string;
  amount: number;
  frequency: string;
  category: string;
}

interface ScheduleCResult {
  /** Always recomputed from `transactions` in exact cents. */
  summary: ScheduleCSummary;
  transactions: Transaction[];
  flagged_items: FlaggedItem[];
  recurring_subscriptions: RecurringSub[];
  statement_period?: { start: string; end: string } | null;
  notes?: string;
}

/** Builds a result from statement lines or a saved report, recomputing every total. */
function buildResult(raw: Record<string, unknown>): ScheduleCResult {
  const transactions = normalizeTransactions(raw.transactions);
  return {
    transactions,
    summary: computeSummary(transactions),
    flagged_items: Array.isArray(raw.flagged_items) ? (raw.flagged_items as FlaggedItem[]) : [],
    recurring_subscriptions: Array.isArray(raw.recurring_subscriptions) ? (raw.recurring_subscriptions as RecurringSub[]) : [],
    statement_period: (raw.statement_period as ScheduleCResult["statement_period"]) ?? null,
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}

const cents$ = (c: number) => formatMoney(c);
const cents$p = (c: number) => formatMoney(c, { parentheses: true });

interface UploadedFile {
  name: string;
  size: number;
  lines: ParsedLine[];
}

/** Reads every sheet and keeps the one with the most recognisable transactions. */
function readStatementWorkbook(wb: XLSX.WorkBook): ParsedLine[] {
  let best: ParsedLine[] = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    const h = findHeaderRow(rows);
    const map = detectColumns(rows[h] ?? []);
    if (map.date === null || (map.amount === null && map.debit === null && map.credit === null)) continue;
    const { lines } = parseLines(rows, h, map);
    if (lines.length > best.length) best = lines;
  }
  return best;
}

const formatCurrency = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const typeBadgeVariant = (type: string) => {
  switch (type) {
    case "income": return "default";
    case "expense": return "secondary";
    case "personal": return "outline";
    case "needs_review": return "destructive";
    default: return "outline";
  }
};

export default function ScheduleC() {
  const { user } = useAuth();
  const [clientName, setClientName] = useState("");
  const [selectedClientId, setSelectedClientId] = useState<string>("");
  const [clients, setClients] = useState<{ id: string; client_name: string }[]>([]);
  const [result, setResult] = useState<ScheduleCResult | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedReportId, setSavedReportId] = useState<string | null>(null);
  const [savedReports, setSavedReports] = useState<any[]>([]);
  const [showSavedReports, setShowSavedReports] = useState(false);
  const [isLoadingReports, setIsLoadingReports] = useState(false);
  const [taxYear, setTaxYear] = useState<number>(() => new Date().getFullYear() - (new Date().getMonth() < 4 ? 1 : 0));
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch clients
  useEffect(() => {
    if (!user) return;
    const fetchClients = async () => {
      const { data } = await supabase
        .from("clients")
        .select("id, client_name")
        .order("client_name");
      if (data) setClients(data);
    };
    fetchClients();
  }, [user]);

  // Opened from a client's page (?client=<id>&year=YYYY): build the P&L from that
  // client's imported bank transactions.
  const [searchParams] = useSearchParams();
  const fromClient = searchParams.get("client");
  const fromYear = Number(searchParams.get("year"));
  useEffect(() => {
    if (!user || !fromClient || !/^[0-9a-f-]{36}$/i.test(fromClient)) return;
    const year = Number.isInteger(fromYear) && fromYear > 1990 ? fromYear : taxYear;
    let cancelled = false;
    (async () => {
      const { data: c } = await supabase.from("clients").select("client_name").eq("id", fromClient).maybeSingle();
      const rows: { txn_date: string; description: string; amount: number; type: string; category: string; notes: string }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from("client_statement_transactions")
          .select("txn_date, description, amount, type, category, notes")
          .eq("client_id", fromClient)
          .gte("txn_date", `${year}-01-01`).lte("txn_date", `${year}-12-31`)
          .order("txn_date").order("id").range(from, from + 999);
        if (error) {
          if (!cancelled) toast({ title: "Couldn't load the client's transactions", description: error.message, variant: "destructive" });
          return;
        }
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      if (cancelled) return;
      setSelectedClientId(fromClient);
      setClientName(c?.client_name ?? "");
      setTaxYear(year);
      setSavedReportId(null);
      setIsConfirmed(false);
      setResult(buildResult({
        transactions: rows.map((r) => ({ date: r.txn_date, description: r.description, amount: Number(r.amount), type: r.type, category: r.category, notes: r.notes })),
        statement_period: rows.length ? { start: rows[0].txn_date, end: rows[rows.length - 1].txn_date } : null,
        notes: `Built from ${rows.length} imported bank transaction${rows.length === 1 ? "" : "s"}. Change categories on the client's page.`,
      }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, fromClient, fromYear]);

  // Fetch saved reports
  const fetchSavedReports = useCallback(async () => {
    if (!user) return;
    setIsLoadingReports(true);
    try {
      const { data, error } = await supabase
        .from("schedule_c_reports")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      setSavedReports(data || []);
    } catch (err: any) {
      toast({ title: "Error loading reports", description: err.message, variant: "destructive" });
    } finally {
      setIsLoadingReports(false);
    }
  }, [user]);

  const handleLoadReport = useCallback((report: any) => {
    setClientName(report.client_name || "");
    setSelectedClientId(report.client_id || "");
    setSavedReportId(report.id);
    setIsConfirmed(report.is_confirmed || false);
    if (report.tax_year) setTaxYear(Number(report.tax_year));
    setResult(buildResult({
      transactions: report.transactions,
      flagged_items: report.flagged_items,
      recurring_subscriptions: report.recurring_subscriptions,
    }));
    setShowSavedReports(false);
    toast({ title: "Report loaded", description: `Loaded report for ${report.client_name}.` });
  }, []);

  const handleDeleteReport = useCallback(async (reportId: string) => {
    try {
      const { error } = await supabase.from("schedule_c_reports").delete().eq("id", reportId);
      if (error) throw error;
      setSavedReports(prev => prev.filter(r => r.id !== reportId));
      if (savedReportId === reportId) setSavedReportId(null);
      toast({ title: "Report deleted" });
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    }
  }, [savedReportId]);

  // Save report to database
  const handleSaveReport = useCallback(async () => {
    if (!result || !user) return;
    if (!clientName.trim() && !selectedClientId) {
      toast({ title: "Client required", description: "Please enter a client name or select a client to save.", variant: "destructive" });
      return;
    }
    setIsSaving(true);
    try {
      const reportData = {
        user_id: user.id,
        client_name: clientName.trim() || clients.find(c => c.id === selectedClientId)?.client_name || "Unknown",
        client_id: selectedClientId || null,
        tax_year: taxYear,
        summary: result.summary as any,
        transactions: result.transactions as any,
        flagged_items: result.flagged_items as any,
        recurring_subscriptions: result.recurring_subscriptions as any,
        is_confirmed: isConfirmed,
        confirmed_at: isConfirmed ? new Date().toISOString() : null,
      };

      if (savedReportId) {
        const { error } = await supabase
          .from("schedule_c_reports")
          .update({ ...reportData, updated_at: new Date().toISOString() })
          .eq("id", savedReportId);
        if (error) throw error;
        toast({ title: "Report updated", description: `Schedule C report saved for ${reportData.client_name}.` });
      } else {
        const { data, error } = await supabase
          .from("schedule_c_reports")
          .insert(reportData)
          .select("id")
          .single();
        if (error) throw error;
        setSavedReportId(data.id);
        toast({ title: "Report saved", description: `Schedule C report saved for ${reportData.client_name}.` });
      }
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  }, [result, user, clientName, selectedClientId, clients, isConfirmed, savedReportId, taxYear]);

  /** Re-categorise one transaction; every total is recomputed from scratch. */
  const updateTransaction = useCallback((index: number, patch: Partial<Transaction>) => {
    setResult((prev) => {
      if (!prev) return prev;
      const transactions = prev.transactions.map((t, i) => {
        if (i !== index) return t;
        const next = { ...t, ...patch };
        // Keep type and category consistent for the non-business buckets
        if (patch.type === "transfer") next.category = "Transfer between accounts";
        if (patch.type === "personal") next.category = "Owner draw or personal";
        if (patch.type === "needs_review") next.category = "Needs review";
        if (patch.category === "Transfer between accounts") next.type = "transfer";
        if (patch.category === "Owner draw or personal") next.type = "personal";
        if (patch.category === "Needs review") next.type = "needs_review";
        if (patch.category === "Sales / gross receipts" || patch.category === "Other business income") next.type = "income";
        return next;
      });
      return { ...prev, transactions, summary: computeSummary(transactions) };
    });
    setIsConfirmed(false);
  }, []);

  const exportExcel = useCallback(() => {
    if (!result) return;
    const s = result.summary;
    const d = (c: number) => c / 100;
    const wb = XLSX.utils.book_new();

    const pnlRows: (string | number)[][] = [
      [`Profit and Loss${clientName ? ` — ${clientName}` : ""}`],
      [result.statement_period?.start ? `Period: ${result.statement_period.start} to ${result.statement_period.end}` : `Tax year ${taxYear}`],
      [],
      ["Income"],
      ...s.pnl.income.map((r) => [`  ${r.category}`, d(r.amount)]),
      ["Total income", d(s.pnl.totalIncome)],
      ["Cost of goods sold", d(s.pnl.cogs)],
      ["Gross profit", d(s.pnl.grossProfit)],
      [],
      ["Expenses"],
      ...s.pnl.expenses.map((r) => [`  ${r.category}`, d(r.amount)]),
      ["Total expenses", d(s.pnl.totalExpenses)],
      [],
      ["Net profit", d(s.pnl.netProfit)],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pnlRows), "Profit and Loss");

    const scRows: (string | number)[][] = [
      ["Schedule C (Form 1040) — prepared figures, review before filing"],
      [],
      ["Line", "Description", "Amount"],
      ["1", "Gross receipts or sales", d(s.scheduleC.line1GrossReceipts)],
      ["4", "Cost of goods sold", d(s.scheduleC.line4Cogs)],
      ["5", "Gross profit", d(s.scheduleC.line5GrossProfit)],
      ["6", "Other income", d(s.scheduleC.line6OtherIncome)],
      ["7", "Gross income", d(s.scheduleC.line7GrossIncome)],
      ...s.scheduleC.expenseLines.map((l) => [l.line, l.label, d(l.amount)]),
      ["28", "Total expenses", d(s.scheduleC.line28TotalExpenses)],
      ["31", "Net profit or (loss)", d(s.scheduleC.line31NetProfit)],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scRows), "Schedule C");

    const txRows = [["Date", "Description", "Amount", "Type", "Category", "Notes"],
      ...result.transactions.map((t) => [t.date, t.description, t.amount, TX_TYPE_LABELS[t.type], t.category, t.notes])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(txRows), "Transactions");

    const safeName = (clientName || "client").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    XLSX.writeFile(wb, `schedule-c-pnl-${safeName}-${taxYear}.xlsx`);
  }, [result, clientName, taxYear]);

  const handlePrintPnl = useCallback(() => {
    if (!result) return;
    const p = result.summary.pnl;
    const esc = (v: string) => v.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
    const row = (label: string, c: number, cls = "") => `<tr class="${cls}"><td>${esc(label)}</td><td class="r">${cents$p(c)}</td></tr>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>Profit and Loss - ${esc(clientName || "Client")}</title>
      <style>
        body{font-family:Arial,sans-serif;padding:40px;color:#111;max-width:720px;margin:auto}
        h1{font-size:22px;margin:0} .sub{color:#666;font-size:13px;margin:4px 0 24px}
        table{width:100%;border-collapse:collapse;font-size:13px} td{padding:5px 8px;border-bottom:1px solid #eee}
        .r{text-align:right;font-variant-numeric:tabular-nums} .h td{font-weight:bold;background:#f5f5f5}
        .t td{font-weight:bold;border-top:1px solid #333} .n td{font-weight:bold;font-size:15px;border-top:3px double #333}
        .indent td:first-child{padding-left:24px} .foot{margin-top:32px;font-size:11px;color:#999}
      </style></head><body>
      <h1>Profit and Loss</h1>
      <p class="sub">${esc(clientName ? `${clientName} · ` : "")}${result.statement_period?.start ? `${esc(result.statement_period.start)} to ${esc(result.statement_period.end)}` : `Tax year ${taxYear}`} · Prepared ${new Date().toLocaleDateString()}</p>
      <table>
        <tr class="h"><td colspan="2">Income</td></tr>
        ${p.income.map((r) => row(r.category, r.amount, "indent")).join("")}
        ${row("Total income", p.totalIncome, "t")}
        ${p.cogs ? row("Cost of goods sold", p.cogs) + row("Gross profit", p.grossProfit, "t") : ""}
        <tr class="h"><td colspan="2">Expenses</td></tr>
        ${p.expenses.map((r) => row(r.category, r.amount, "indent")).join("")}
        ${row("Total expenses", p.totalExpenses, "t")}
        ${row("Net profit", p.netProfit, "n")}
      </table>
      <p class="foot">Prepared by MAJR Books from bank statement data. Transfers, personal items and items marked for review are excluded. Review before relying on these figures.</p>
      </body></html>`);
    w.document.close();
    w.print();
  }, [result, clientName, taxYear]);
  const handlePrintSummary = useCallback(() => {
    if (!result) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    printWindow.document.write(`
      <html><head><title>Schedule C Summary - ${clientName || "Client"}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; color: #111; }
        h1 { font-size: 22px; margin-bottom: 4px; }
        .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; }
        .kpi-row { display: flex; gap: 32px; margin-bottom: 16px; }
        .kpi-label { font-size: 12px; color: #666; }
        .kpi-value { font-size: 22px; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
        th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
        th { background: #f5f5f5; font-weight: 600; }
        .text-right { text-align: right; }
        .confirmed-badge { display: inline-block; background: #22c55e; color: white; padding: 2px 10px; border-radius: 4px; font-size: 12px; margin-left: 12px; }
        .footer { margin-top: 40px; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 8px; }
        @media print { body { padding: 20px; } }
      </style></head><body>
      <h1>Schedule C Expense Summary ${isConfirmed ? '<span class="confirmed-badge">✓ Client Confirmed</span>' : ''}</h1>
      <p class="subtitle">${clientName ? `Client: ${clientName} • ` : ''}Generated: ${new Date().toLocaleDateString()}</p>
      <div class="kpi-row">
        <div><div class="kpi-label">Gross Income</div><div class="kpi-value">${formatCurrency(result.summary.total_income)}</div></div>
        <div><div class="kpi-label">Total Expenses</div><div class="kpi-value">${formatCurrency(result.summary.total_expenses)}</div></div>
        <div><div class="kpi-label">Net Profit</div><div class="kpi-value">${formatCurrency(result.summary.net_profit)}</div></div>
      </div>
      <h2 style="font-size:16px;border-bottom:1px solid #ccc;padding-bottom:4px;margin-top:24px;">Expense Breakdown by IRS Category</h2>
      <table><thead><tr><th>Category</th><th class="text-right">Amount</th></tr></thead><tbody>
      ${Object.entries(result.summary.expense_totals).sort(([, a], [, b]) => b - a).map(([cat, amt]) => `<tr><td>${cat}</td><td class="text-right">${formatCurrency(amt)}</td></tr>`).join("")}
      <tr style="font-weight:bold;border-top:2px solid #333"><td>Total Expenses</td><td class="text-right">${formatCurrency(result.summary.total_expenses)}</td></tr>
      </tbody></table>
      ${result.flagged_items.length > 0 ? `
        <h2 style="font-size:16px;border-bottom:1px solid #ccc;padding-bottom:4px;margin-top:24px;">Flagged Items (${result.flagged_items.length})</h2>
        <table><thead><tr><th>Date</th><th>Description</th><th class="text-right">Amount</th><th>Reason</th></tr></thead><tbody>
        ${result.flagged_items.map(it => `<tr><td>${it.date}</td><td>${it.description}</td><td class="text-right">${formatCurrency(it.amount)}</td><td>${it.reason}</td></tr>`).join("")}
        </tbody></table>
      ` : ''}
      <p class="footer">Generated by MAJR Books Schedule C Preparation tool. Please review all categorizations before filing.</p>
      </body></html>
    `);
    printWindow.document.close();
    printWindow.print();
  }, [result, clientName, isConfirmed]);

  const handlePrintScheduleC = useCallback(() => {
    if (!result) return;
    const sc = result.summary.scheduleC;
    const esc = (v: string) => v.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
    const amt = (c: number) => (c ? cents$p(c) : "");
    const lineRow = (line: string, label: string, c: number, total = false) =>
      `<div class="line-row"><span class="line-num">${line}</span><span class="line-label">${esc(label)}</span><span class="line-amount${total ? " total" : ""}">${amt(c)}</span></div>`;
    const otherDetail = sc.otherExpenseDetail.length
      ? `<div class="section-title">Part V — Other Expenses (line 27a detail)</div>
         <table class="other-table">${sc.otherExpenseDetail
           .map((r) => `<tr><td>${esc(r.category)}</td><td style="text-align:right;width:130px">${cents$p(r.amount)}</td></tr>`)
           .join("")}</table>`
      : "";
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    printWindow.document.write(`
      <html><head><title>Schedule C (Form 1040) - ${esc(clientName || "Taxpayer")}</title>
      <style>
        body { font-family: 'Courier New', monospace; padding: 30px; color: #000; font-size: 12px; }
        h1 { font-size: 16px; text-align: center; margin-bottom: 2px; font-family: Arial, sans-serif; }
        h2 { font-size: 13px; text-align: center; margin-bottom: 2px; font-family: Arial, sans-serif; font-weight: normal; }
        .form-header { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #000; padding-bottom: 10px; }
        .dept { font-size: 10px; color: #666; }
        .section-title { font-weight: bold; font-size: 13px; background: #eee; padding: 4px 8px; margin: 16px 0 8px; font-family: Arial, sans-serif; }
        .line-row { display: flex; align-items: baseline; padding: 3px 0; border-bottom: 1px dotted #ccc; }
        .line-num { width: 40px; font-weight: bold; flex-shrink: 0; }
        .line-label { flex: 1; }
        .line-amount { width: 130px; text-align: right; font-weight: bold; border-bottom: 1px solid #000; padding: 0 4px; }
        .line-amount.total { border-bottom: 3px double #000; }
        .info-row { display: flex; gap: 20px; margin-bottom: 6px; }
        .info-label { font-size: 10px; color: #666; }
        .info-field { border-bottom: 1px solid #000; padding: 2px 4px; min-width: 180px; display: inline-block; }
        .other-table { width: 100%; border-collapse: collapse; margin: 8px 0; }
        .other-table td { border: 1px solid #ccc; padding: 3px 6px; }
        .confirmed-stamp { position: fixed; top: 40%; right: 10%; transform: rotate(-15deg); font-size: 48px; color: rgba(34,197,94,0.2); font-weight: bold; font-family: Arial; border: 4px solid rgba(34,197,94,0.2); padding: 10px 20px; border-radius: 12px; pointer-events: none; }
        .footer { margin-top: 30px; font-size: 10px; color: #777; text-align: center; }
        @media print { body { padding: 15px; } }
      </style></head><body>
      ${isConfirmed ? '<div class="confirmed-stamp">CLIENT CONFIRMED</div>' : ""}
      <div class="form-header">
        <h1>SCHEDULE C (Form 1040)</h1>
        <h2>Profit or Loss From Business (Sole Proprietorship)</h2>
        <p class="dept">Preparation worksheet — not an official IRS form</p>
      </div>
      <div class="info-row"><span class="info-label">Name of proprietor:</span> <span class="info-field">${esc(clientName || "")}</span> <span class="info-label" style="margin-left:20px">Tax year:</span> <span class="info-field">${taxYear}</span></div>
      <div class="info-row"><span class="info-label">Principal business:</span> <span class="info-field"></span> <span class="info-label" style="margin-left:20px">Business code:</span> <span class="info-field"></span></div>

      <div class="section-title">Part I — Income</div>
      ${lineRow("1", "Gross receipts or sales", sc.line1GrossReceipts)}
      ${lineRow("2", "Returns and allowances", 0)}
      ${lineRow("3", "Subtract line 2 from line 1", sc.line1GrossReceipts)}
      ${lineRow("4", "Cost of goods sold", sc.line4Cogs)}
      ${lineRow("5", "Gross profit", sc.line5GrossProfit)}
      ${lineRow("6", "Other income", sc.line6OtherIncome)}
      ${lineRow("7", "Gross income", sc.line7GrossIncome, true)}

      <div class="section-title">Part II — Expenses</div>
      ${sc.expenseLines.map((l) => lineRow(l.line, l.label, l.amount)).join("")}
      ${lineRow("28", "Total expenses", sc.line28TotalExpenses, true)}
      ${lineRow("29", "Tentative profit or (loss)", sc.line7GrossIncome - sc.line28TotalExpenses)}
      ${lineRow("30", "Expenses for business use of your home", 0)}
      ${lineRow("31", "Net profit or (loss)", sc.line31NetProfit, true)}

      ${otherDetail}
      <p class="footer">Prepared by MAJR Books from bank statements · ${new Date().toLocaleDateString()}<br/>
      Meals are shown at 50%. Transfers, personal items and items marked "needs review" are excluded.<br/>
      Tax mappings are a starting point and must be reviewed by a qualified professional before filing.</p>
      </body></html>
    `);
    printWindow.document.close();
    printWindow.print();
  }, [result, clientName, isConfirmed, taxYear]);

  const processFile = useCallback(async (file: globalThis.File): Promise<UploadedFile | null> => {
    if (file.size > 15 * 1024 * 1024) {
      toast({ title: "File too large", description: `${file.name} is over the 15 MB limit. Split the statement into smaller files.`, variant: "destructive" });
      return null;
    }
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      toast({ title: "Excel or CSV only", description: `${file.name}: download the statement from the bank as Excel (.xlsx) or CSV.`, variant: "destructive" });
      return null;
    }
    let lines: ParsedLine[];
    try {
      lines = readStatementWorkbook(XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true, raw: false }));
    } catch {
      toast({ title: "Couldn't open the file", description: `${file.name} isn't a readable Excel or CSV file.`, variant: "destructive" });
      return null;
    }
    if (!lines.length) {
      toast({
        title: "No transactions found",
        description: `${file.name}: couldn't find Date and Amount (or Debit/Credit) columns. Check the file has a header row with those column names.`,
        variant: "destructive",
      });
      return null;
    }
    return { name: file.name, size: file.size, lines };
  }, []);

  const addFiles = useCallback(async (files: FileList | globalThis.File[]) => {
    const processed: UploadedFile[] = [];
    const isSame = (a: { name: string; size: number }, b: { name: string; size: number }) => a.name === b.name && a.size === b.size;
    for (const f of Array.from(files)) {
      // The same statement added twice would count every transaction twice.
      if (uploadedFiles.some((u) => isSame(u, f)) || processed.some((u) => isSame(u, f))) {
        toast({ title: "Already added", description: `${f.name} is already in the list, so it was skipped.` });
        continue;
      }
      const r = await processFile(f);
      if (r) processed.push(r);
    }
    if (processed.length > 0) {
      setUploadedFiles((prev) => [...prev, ...processed]);
      const n = processed.reduce((s, f) => s + f.lines.length, 0);
      toast({ title: "Files loaded", description: `${n} transactions found in ${processed.length} file(s).` });
    }
  }, [processFile, uploadedFiles]);

  const removeFile = useCallback((index: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await addFiles(files);
    e.target.value = "";
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) await addFiles(files);
  }, [addFiles]);

  /** Sorts every transaction with the built-in rules and builds the P&L / Schedule C. */
  const buildReport = useCallback(() => {
    const all = uploadedFiles.flatMap((f) => f.lines).sort((a, b) => a.date.localeCompare(b.date));
    if (!all.length) {
      toast({ title: "No data", description: "Upload an Excel or CSV bank statement first.", variant: "destructive" });
      return;
    }
    setIsConfirmed(false);
    setSavedReportId(null);
    const built = buildResult({
      transactions: all.map((l) => ({ date: l.date, description: l.description, amount: l.cents / 100, ...categorize(l.description, l.direction) })),
      statement_period: { start: all[0].date, end: all[all.length - 1].date },
      notes: "",
    });
    setResult(built);
    const endYear = Number(all[all.length - 1].date.slice(0, 4));
    if (endYear > 1990 && endYear < 2100) setTaxYear(endYear);
    const review = built.summary.excluded.needsReviewCount;
    toast({ title: "Done", description: `${all.length} transactions sorted${review ? ` · ${review} need your review` : ""}.` });
  }, [uploadedFiles]);

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Schedule C &amp; P&amp;L from Bank Statements</h1>
            <p className="text-muted-foreground mt-1">
              Upload Excel or CSV bank statements; MAJR Books sorts every transaction and builds the Profit &amp; Loss and Schedule C
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => { setShowSavedReports(true); fetchSavedReports(); }}
          >
            <FolderOpen className="h-4 w-4 mr-2" />
            Saved Reports
          </Button>
        </div>

        {/* Saved Reports Dialog */}
        <Dialog open={showSavedReports} onOpenChange={setShowSavedReports}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FolderOpen className="h-5 w-5" />
                Saved Schedule C Reports
              </DialogTitle>
            </DialogHeader>
            {isLoadingReports ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : savedReports.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <FileText className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p className="font-medium">No saved reports yet</p>
                <p className="text-sm mt-1">Analyze and save a report to see it here.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {savedReports.map((report) => (
                  <div
                    key={report.id}
                    className="flex items-center justify-between border rounded-lg p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{report.client_name}</span>
                        <Badge variant={report.is_confirmed ? "default" : "secondary"}>
                          {report.is_confirmed ? "Confirmed" : "Draft"}
                        </Badge>
                        <Badge variant="outline">{report.tax_year}</Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(report.updated_at).toLocaleDateString()}
                        </span>
                        {report.summary?.net_profit != null && (
                          <span>Net: {formatCurrency(report.summary.net_profit)}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 ml-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleLoadReport(report)}
                      >
                        <Eye className="h-4 w-4 mr-1" />
                        Open
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => handleDeleteReport(report.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Input Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Import Transactions
            </CardTitle>
            <CardDescription>
              Upload a CSV/text file or paste bank statement data below
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 max-w-md">
                <label className="text-sm font-medium mb-1.5 block">Select Client</label>
                <Select
                  value={selectedClientId}
                  onValueChange={(val) => {
                    setSelectedClientId(val);
                    const client = clients.find(c => c.id === val);
                    if (client) setClientName(client.client_name);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose an existing client..." />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map(c => (
                      <SelectItem key={c.id} value={c.id}>{c.client_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 max-w-md">
                <label className="text-sm font-medium mb-1.5 block">Or enter client name</label>
                <Input
                  placeholder="e.g. John Smith"
                  value={clientName}
                  onChange={(e) => {
                    setClientName(e.target.value);
                    if (selectedClientId) setSelectedClientId("");
                  }}
                  className="max-w-md"
                />
              </div>
            </div>

            {/* Drag & Drop Upload Zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                isDragging
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                multiple
                onChange={handleFileUpload}
                className="hidden"
              />
              <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">
                Drag & drop files here, or click to browse
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Bank statements as Excel (.xlsx, .xls) or CSV • Max 15 MB each
              </p>
            </div>

            {/* Uploaded Files List */}
            {uploadedFiles.length > 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Uploaded Files ({uploadedFiles.length})</label>
                <div className="space-y-1.5">
                  {uploadedFiles.map((f, i) => (
                    <div key={i} className="flex items-center justify-between bg-muted/50 rounded-md px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <File className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">{f.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0">({formatFileSize(f.size)})</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => removeFile(i)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Button onClick={buildReport} disabled={uploadedFiles.length === 0} className="w-full md:w-auto">
              <ClipboardList className="h-4 w-4 mr-2" />
              Build P&amp;L and Schedule C
            </Button>
          </CardContent>
        </Card>

        {/* Results */}
        {result && (
          <Tabs defaultValue="summary" className="space-y-4">
            {/* Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <TabsList className="flex-wrap h-auto">
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="pnl">Profit &amp; Loss</TabsTrigger>
                <TabsTrigger value="schedule-c">Schedule C</TabsTrigger>
                <TabsTrigger value="transactions">
                  Transactions ({result.transactions.length})
                </TabsTrigger>
                <TabsTrigger value="flagged">
                  Flagged ({result.flagged_items.length})
                </TabsTrigger>
                <TabsTrigger value="recurring">
                  Recurring ({result.recurring_subscriptions.length})
                </TabsTrigger>
              </TabsList>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={String(taxYear)} onValueChange={(v) => setTaxYear(Number(v))}>
                  <SelectTrigger className="w-[120px]" aria-label="Tax year"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - i).map((y) => (
                      <SelectItem key={y} value={String(y)}>Tax year {y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" onClick={exportExcel} className="gap-2">
                  <FileText className="h-4 w-4" />
                  Export Excel
                </Button>
                <Button variant="outline" onClick={handlePrintPnl} className="gap-2">
                  <Printer className="h-4 w-4" />
                  Print P&amp;L
                </Button>
                {!isConfirmed ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsConfirmed(true);
                      toast({ title: "Confirmed", description: "Summary has been confirmed by client." });
                    }}
                    className="gap-2"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Confirm Summary
                  </Button>
                ) : (
                  <Badge variant="default" className="gap-1 py-1.5 px-3 text-sm bg-green-600 hover:bg-green-600">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Client Confirmed
                  </Badge>
                )}
                <Button variant="outline" onClick={handleSaveReport} disabled={isSaving} className="gap-2">
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {savedReportId ? "Update Report" : "Save Report"}
                </Button>
                <Button variant="outline" onClick={handlePrintSummary} className="gap-2">
                  <Printer className="h-4 w-4" />
                  Print Summary
                </Button>
                <Button onClick={handlePrintScheduleC} className="gap-2">
                  <FileText className="h-4 w-4" />
                  Print Schedule C
                </Button>
              </div>
            </div>

            {(result.summary.excluded.needsReviewCount > 0 || result.notes) && (
              <Card className="border-yellow-500/50 bg-yellow-50/50 dark:bg-yellow-950/20">
                <CardContent className="pt-6 space-y-1 text-sm">
                  {result.summary.excluded.needsReviewCount > 0 && (
                    <p className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" />
                      <span>
                        <strong>{result.summary.excluded.needsReviewCount} transaction{result.summary.excluded.needsReviewCount === 1 ? "" : "s"} ({cents$(result.summary.excluded.needsReview)})</strong>{" "}
                        couldn't be classified and are left out of the totals. Open the Transactions tab and choose a category for each.
                      </span>
                    </p>
                  )}
                  {result.notes && <p className="text-muted-foreground">{result.notes}</p>}
                </CardContent>
              </Card>
            )}

            {/* Profit and loss */}
            <TabsContent value="pnl">
              <Card>
                <CardHeader>
                  <CardTitle>Profit and Loss</CardTitle>
                  <CardDescription>
                    {result.statement_period?.start
                      ? `${result.statement_period.start} to ${result.statement_period.end}`
                      : `Tax year ${taxYear}`}
                    {" · "}Transfers ({cents$(result.summary.excluded.transfers)}) and personal items ({cents$(result.summary.excluded.personal)}) are excluded.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableBody>
                      <TableRow className="bg-muted/50 font-semibold"><TableCell colSpan={2}>Income</TableCell></TableRow>
                      {result.summary.pnl.income.map((r) => (
                        <TableRow key={`i-${r.category}`}>
                          <TableCell className="pl-8">{r.category}</TableCell>
                          <TableCell className="text-right font-mono">{cents$p(r.amount)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-semibold">
                        <TableCell>Total income</TableCell>
                        <TableCell className="text-right font-mono">{cents$p(result.summary.pnl.totalIncome)}</TableCell>
                      </TableRow>
                      {result.summary.pnl.cogs !== 0 && (
                        <>
                          <TableRow>
                            <TableCell>Cost of goods sold</TableCell>
                            <TableCell className="text-right font-mono">{cents$p(result.summary.pnl.cogs)}</TableCell>
                          </TableRow>
                          <TableRow className="font-semibold">
                            <TableCell>Gross profit</TableCell>
                            <TableCell className="text-right font-mono">{cents$p(result.summary.pnl.grossProfit)}</TableCell>
                          </TableRow>
                        </>
                      )}
                      <TableRow className="bg-muted/50 font-semibold"><TableCell colSpan={2}>Expenses</TableCell></TableRow>
                      {result.summary.pnl.expenses.map((r) => (
                        <TableRow key={`e-${r.category}`}>
                          <TableCell className="pl-8">{r.category}</TableCell>
                          <TableCell className="text-right font-mono">{cents$p(r.amount)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-semibold">
                        <TableCell>Total expenses</TableCell>
                        <TableCell className="text-right font-mono">{cents$p(result.summary.pnl.totalExpenses)}</TableCell>
                      </TableRow>
                      <TableRow className="font-bold text-base border-t-2">
                        <TableCell>Net profit</TableCell>
                        <TableCell className="text-right font-mono">{cents$p(result.summary.pnl.netProfit)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Schedule C lines */}
            <TabsContent value="schedule-c">
              <Card>
                <CardHeader>
                  <CardTitle>Schedule C (Form 1040), tax year {taxYear}</CardTitle>
                  <CardDescription>
                    Meals are counted at 50% here (full amount on the P&amp;L). Tax mappings are a starting point and must be reviewed by a qualified professional before filing.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">Line</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[
                        ["1", "Gross receipts or sales", result.summary.scheduleC.line1GrossReceipts],
                        ["4", "Cost of goods sold", result.summary.scheduleC.line4Cogs],
                        ["5", "Gross profit", result.summary.scheduleC.line5GrossProfit],
                        ["6", "Other income", result.summary.scheduleC.line6OtherIncome],
                        ["7", "Gross income", result.summary.scheduleC.line7GrossIncome],
                      ].map(([line, label, amount]) => (
                        <TableRow key={line as string} className={line === "7" ? "font-semibold" : undefined}>
                          <TableCell className="font-mono">{line}</TableCell>
                          <TableCell>{label}</TableCell>
                          <TableCell className="text-right font-mono">{cents$p(amount as number)}</TableCell>
                        </TableRow>
                      ))}
                      {result.summary.scheduleC.expenseLines.map((l) => (
                        <TableRow key={`l-${l.line}`}>
                          <TableCell className="font-mono">{l.line}</TableCell>
                          <TableCell>{l.label}</TableCell>
                          <TableCell className="text-right font-mono">{cents$p(l.amount)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-semibold">
                        <TableCell className="font-mono">28</TableCell>
                        <TableCell>Total expenses</TableCell>
                        <TableCell className="text-right font-mono">{cents$p(result.summary.scheduleC.line28TotalExpenses)}</TableCell>
                      </TableRow>
                      <TableRow className="font-bold border-t-2">
                        <TableCell className="font-mono">31</TableCell>
                        <TableCell>Net profit or (loss)</TableCell>
                        <TableCell className="text-right font-mono">{cents$p(result.summary.scheduleC.line31NetProfit)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Summary Tab */}
            <TabsContent value="summary" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-primary/20">
                        <TrendingUp className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Gross Income</p>
                        <p className="text-2xl font-bold">{formatCurrency(result.summary.total_income)}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-destructive/20">
                        <TrendingDown className="h-5 w-5 text-destructive" />
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Total Expenses</p>
                        <p className="text-2xl font-bold">{formatCurrency(result.summary.total_expenses)}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-primary/20">
                        <DollarSign className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Net Profit</p>
                        <p className="text-2xl font-bold">{formatCurrency(result.summary.net_profit)}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Expense Breakdown by Category</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Object.entries(result.summary.expense_totals)
                        .sort(([, a], [, b]) => b - a)
                        .map(([cat, amt]) => (
                          <TableRow key={cat}>
                            <TableCell>{cat}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatCurrency(amt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      <TableRow className="font-bold border-t-2">
                        <TableCell>Total Expenses</TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(result.summary.total_expenses)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Transactions Tab */}
            <TabsContent value="transactions">
              <Card>
                <CardContent className="pt-6">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Category</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Notes</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.transactions.map((tx, i) => (
                          <TableRow key={i}>
                            <TableCell className="whitespace-nowrap">{tx.date}</TableCell>
                            <TableCell className="max-w-[200px] truncate">{tx.description}</TableCell>
                            <TableCell className="text-right font-mono whitespace-nowrap">
                              {formatCurrency(tx.amount)}
                            </TableCell>
                            <TableCell className="min-w-[220px]">
                              <Select value={tx.category} onValueChange={(v) => updateTransaction(i, { category: v })}>
                                <SelectTrigger className="h-8 text-xs" aria-label={`Category for ${tx.description}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {(ALL_CATEGORY_NAMES.includes(tx.category) ? ALL_CATEGORY_NAMES : [tx.category, ...ALL_CATEGORY_NAMES]).map((c) => (
                                    <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="min-w-[140px]">
                              <Select value={tx.type} onValueChange={(v) => updateTransaction(i, { type: v as TxType })}>
                                <SelectTrigger className="h-8 text-xs" aria-label={`Type for ${tx.description}`}>
                                  <Badge variant={typeBadgeVariant(tx.type)}>{TX_TYPE_LABELS[tx.type]}</Badge>
                                </SelectTrigger>
                                <SelectContent>
                                  {(Object.keys(TX_TYPE_LABELS) as TxType[]).map((t) => (
                                    <SelectItem key={t} value={t} className="text-xs">{TX_TYPE_LABELS[t]}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="max-w-[150px] truncate text-muted-foreground text-sm">
                              {tx.notes}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Flagged Tab */}
            <TabsContent value="flagged">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-yellow-500" />
                    Items Requiring Review
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {result.flagged_items.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8">No flagged items.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Reason</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.flagged_items.map((item, i) => (
                          <TableRow key={i}>
                            <TableCell>{item.date}</TableCell>
                            <TableCell>{item.description}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatCurrency(item.amount)}
                            </TableCell>
                            <TableCell className="text-chart-3">{item.reason}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Recurring Tab */}
            <TabsContent value="recurring">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <RefreshCw className="h-5 w-5" />
                    Recurring Subscriptions
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {result.recurring_subscriptions.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8">No recurring subscriptions detected.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Description</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Frequency</TableHead>
                          <TableHead>Category</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.recurring_subscriptions.map((sub, i) => (
                          <TableRow key={i}>
                            <TableCell>{sub.description}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatCurrency(sub.amount)}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{sub.frequency}</Badge>
                            </TableCell>
                            <TableCell>{sub.category}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </Layout>
  );
}
