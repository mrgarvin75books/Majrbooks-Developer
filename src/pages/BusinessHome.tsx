import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  AlertCircle, ArrowDownRight, ArrowUpRight, CheckCircle2, ChevronRight, Info, Landmark, Receipt, Scale, Wallet,
} from "lucide-react";
import Layout from "@/components/Layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip as UiTooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import { ledgerErrorMessage, useCurrentBusiness } from "@/hooks/useCurrentBusiness";
import { formatMoney, formatMoneyCompact, toCents } from "@/lib/money";
import {
  COMPARE_LABELS, RANGE_LABELS, compareRange, formatRange, parseIso, percentChange, resolveRange,
  type CompareKey, type DateRange, type RangeKey,
} from "@/lib/dateRanges";
import JournalEntryDetailDialog from "@/components/JournalEntryDetailDialog";
import { cn } from "@/lib/utils";

interface DashboardData {
  kpis: {
    income: number; expenses: number; net_profit: number; cash: number;
    compare: { income: number; expenses: number; net_profit: number; cash: number } | null;
    accounts_receivable: number; accounts_payable: number; has_ledger_activity: boolean;
  };
  monthly: { month: string; income: number; expenses: number }[];
  top_expenses: { account_id: string; name: string; amount: number }[];
  other_expenses: number;
  bank_accounts: {
    account_id: string; name: string; account_number: string | null; is_undeposited: boolean;
    book_balance: number; bank_balance: number | null; last_reconciled: string | null; unreviewed: number;
  }[];
  recent: {
    entry_id: string; entry_number: string; entry_date: string; memo: string | null;
    source_type: string | null; status: string; is_reversal: boolean; amount: number;
  }[];
  owed: {
    invoices_open_count: number; invoices_open_total: number; invoices_overdue_count: number; invoices_overdue_total: number;
    bills_open_count: number; bills_open_total: number; bills_due_soon_count: number; bills_due_soon_total: number;
  };
  tasks: { unreviewed_bank_lines: number; stale_reconciliations: number; overdue_invoices: number; bills_due_soon: number; draft_entries: number };
  not_in_ledger: { transactions: number; bills: number };
}

const RANGE_KEY = "majr.home.range";
const COMPARE_KEY = "majr.home.compare";
const read = <T extends string>(key: string, fallback: T, allowed: readonly string[]): T => {
  try {
    const v = localStorage.getItem(key);
    return v && allowed.includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
};

const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" });
};
const shortDate = (iso: string) => {
  const { y, m, d } = parseIso(iso);
  return new Date(y, m, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** ⓘ next to accounting terms (blueprint label rules). */
const Term = ({ children, help }: { children: React.ReactNode; help: string }) => (
  <span className="inline-flex items-center gap-1">
    {children}
    <UiTooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={help}>
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{help}</TooltipContent>
    </UiTooltip>
  </span>
);

const Money = ({ cents, className }: { cents: number; className?: string }) => (
  <span className={className} title={formatMoney(cents)}>{formatMoneyCompact(cents)}</span>
);

function KpiTile({
  label, help, cents, compareCents, to, positiveIsGood = true, sublabel, icon: Icon,
}: {
  label: string; help: string; cents: number; compareCents: number | null; to: string;
  positiveIsGood?: boolean; sublabel?: string; icon: typeof Wallet;
}) {
  const change = compareCents === null ? null : percentChange(cents, compareCents);
  const up = change !== null && change > 0;
  const good = change === null || change === 0 ? null : up === positiveIsGood;
  return (
    <Link to={to} className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Card className="h-full transition-shadow group-hover:shadow-md">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm text-muted-foreground"><Term help={help}>{label}</Term></div>
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="mt-2 text-2xl font-semibold tracking-tight">
            <Money cents={cents} />
          </div>
          <div className="mt-1 h-5 text-xs">
            {sublabel ? (
              <span className="text-muted-foreground">{sublabel}</span>
            ) : change === null ? (
              compareCents !== null && <span className="text-muted-foreground">No earlier figures to compare</span>
            ) : (
              <span className={cn("inline-flex items-center gap-0.5 font-medium",
                good === null ? "text-muted-foreground" : good ? "text-green-700" : "text-destructive")}>
                {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                {Math.abs(change).toFixed(change !== 0 && Math.abs(change) < 10 ? 1 : 0)}%
                <span className="font-normal text-muted-foreground ml-1">vs comparison period</span>
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

const EXPENSE_COLORS = [
  "hsl(215 60% 30%)", "hsl(215 45% 45%)", "hsl(215 35% 60%)", "hsl(130 35% 40%)", "hsl(130 30% 58%)", "hsl(38 70% 55%)", "hsl(215 15% 78%)",
];

const BusinessHome = () => {
  const { business, canKeepBooks, isLoading: businessLoading, error: businessError } = useCurrentBusiness();
  const [rangeKey, setRangeKey] = useState<RangeKey>(() => read(RANGE_KEY, "ytd", Object.keys(RANGE_LABELS)));
  const [compareKey, setCompareKey] = useState<CompareKey>(() => read(COMPARE_KEY, "prior_period", Object.keys(COMPARE_LABELS)));
  const [custom, setCustom] = useState<DateRange>(() => resolveRange("this_month"));
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);

  const range = useMemo(() => resolveRange(rangeKey, new Date(), custom), [rangeKey, custom]);
  const cmp = useMemo(() => compareRange(range, compareKey), [range, compareKey]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["business-dashboard", business?.business_id, range.from, range.to, cmp?.from, cmp?.to],
    enabled: !!business,
    queryFn: async () => {
      const { data: d, error: e } = await supabase.rpc("business_dashboard", {
        p_business_id: business!.business_id,
        p_from: range.from,
        p_to: range.to,
        p_compare_from: cmp?.from ?? null,
        p_compare_to: cmp?.to ?? null,
      });
      if (e) throw e;
      return d as unknown as DashboardData;
    },
  });

  const loadError = businessError ?? error;
  const k = data?.kpis;
  const c = k?.compare ?? null;
  const fresh = !!data && !k?.has_ledger_activity;

  const monthly = (data?.monthly ?? []).map((m) => ({
    month: monthLabel(m.month),
    Income: toCents(m.income) / 100,
    Expenses: toCents(m.expenses) / 100,
  }));
  const hasMonthly = monthly.some((m) => m.Income !== 0 || m.Expenses !== 0);
  const expenseSlices = [
    ...(data?.top_expenses ?? []).map((e) => ({ name: e.name, value: toCents(e.amount) / 100 })),
    ...(toCents(data?.other_expenses) > 0 ? [{ name: "Everything else", value: toCents(data?.other_expenses) / 100 }] : []),
  ];

  const tasks = data
    ? [
        { n: data.tasks.unreviewed_bank_lines, label: "bank transactions to review", to: "/bank-transactions" },
        { n: data.tasks.stale_reconciliations, label: "accounts not reconciled in 45 days", to: "/bank-reconciliation" },
        { n: data.tasks.overdue_invoices, label: "overdue invoices", to: "/invoices?status=outstanding" },
        { n: data.tasks.bills_due_soon, label: "bills due within 7 days", to: "/expenses" },
        ...(canKeepBooks ? [{ n: data.tasks.draft_entries, label: "draft journal entries to post", to: "/journal-entries" }] : []),
      ].filter((t) => t.n > 0)
    : [];

  return (
    <Layout>
      <div className="space-y-6 max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">Home</h1>
            <p className="text-muted-foreground mt-1">
              {business?.name ?? "Your business"} · {formatRange(range)}
              {cmp && <span className="hidden md:inline"> · compared with {formatRange(cmp)}</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="home-range" className="text-xs text-muted-foreground">Period</Label>
              <Select value={rangeKey} onValueChange={(v) => { setRangeKey(v as RangeKey); write(RANGE_KEY, v); }}>
                <SelectTrigger id="home-range" className="w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(RANGE_LABELS) as RangeKey[]).map((key) => (
                    <SelectItem key={key} value={key}>{RANGE_LABELS[key]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {rangeKey === "custom" && (
              <>
                <div className="space-y-1">
                  <Label htmlFor="home-from" className="text-xs text-muted-foreground">From</Label>
                  <Input id="home-from" type="date" className="w-[150px]" value={custom.from}
                    onChange={(e) => e.target.value && setCustom((p) => ({ ...p, from: e.target.value }))} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="home-to" className="text-xs text-muted-foreground">To</Label>
                  <Input id="home-to" type="date" className="w-[150px]" value={custom.to}
                    onChange={(e) => e.target.value && setCustom((p) => ({ ...p, to: e.target.value }))} />
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label htmlFor="home-compare" className="text-xs text-muted-foreground">Compare to</Label>
              <Select value={compareKey} onValueChange={(v) => { setCompareKey(v as CompareKey); write(COMPARE_KEY, v); }}>
                <SelectTrigger id="home-compare" className="w-[190px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(COMPARE_LABELS) as CompareKey[]).map((key) => (
                    <SelectItem key={key} value={key}>{COMPARE_LABELS[key]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {loadError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {ledgerErrorMessage(loadError)}
              {" "}If this keeps happening, the latest database update may not be installed on this environment yet.
            </AlertDescription>
          </Alert>
        )}

        {data && (data.not_in_ledger.transactions > 0 || data.not_in_ledger.bills > 0) && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              {[
                data.not_in_ledger.transactions > 0 && `${data.not_in_ledger.transactions} transaction${data.not_in_ledger.transactions === 1 ? "" : "s"} from the older Transactions screen`,
                data.not_in_ledger.bills > 0 && `${data.not_in_ledger.bills} open bill${data.not_in_ledger.bills === 1 ? "" : "s"}`,
              ].filter(Boolean).join(" and ")}{" "}
              {data.not_in_ledger.transactions + data.not_in_ledger.bills === 1 ? "isn't" : "aren't"} in your books yet,
              so {data.not_in_ledger.transactions + data.not_in_ledger.bills === 1 ? "it isn't" : "they aren't"} included in these figures.
              Invoices, payments and journal entries are.
            </AlertDescription>
          </Alert>
        )}

        {/* Row 1: KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {isLoading || businessLoading || !k ? (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[124px] rounded-xl" />)
          ) : (
            <>
              <KpiTile label="Income" icon={ArrowUpRight} cents={toCents(k.income)} compareCents={c ? toCents(c.income) : null}
                to="/profit-and-loss" help="Money earned in this period: invoices you've sent plus other income, before expenses." />
              <KpiTile label="Expenses" icon={ArrowDownRight} cents={toCents(k.expenses)} compareCents={c ? toCents(c.expenses) : null}
                to="/profit-and-loss" positiveIsGood={false} help="Costs recorded in your books for this period." />
              <KpiTile label="Net profit" icon={Scale} cents={toCents(k.net_profit)} compareCents={c ? toCents(c.net_profit) : null}
                to="/profit-and-loss" help="Income minus expenses for this period." />
              <KpiTile label="Cash and bank" icon={Landmark} cents={toCents(k.cash)} compareCents={null}
                to="/bank-transactions" sublabel={`All bank accounts on ${shortDate(range.to)}`}
                help="What your bank and cash accounts hold according to your books, including payments received but not yet deposited." />
            </>
          )}
        </div>

        {/* Row 2: tasks + owed and owing */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className={cn(tasks.length > 0 && "border-primary/40")}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Needs your attention</CardTitle>
            </CardHeader>
            <CardContent>
              {!data ? (
                <Skeleton className="h-24" />
              ) : tasks.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                  <CheckCircle2 className="h-5 w-5 text-green-600" /> You're all caught up.
                </div>
              ) : (
                <ul className="divide-y">
                  {tasks.map((t) => (
                    <li key={t.label}>
                      <Link to={t.to} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:text-primary">
                        <span><Badge variant="secondary" className="mr-2 tabular-nums">{t.n}</Badge>{t.label}</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Owed and owing</CardTitle>
            </CardHeader>
            <CardContent>
              {!data ? <Skeleton className="h-24" /> : (
                <dl className="divide-y text-sm">
                  <Link to="/invoices?status=outstanding" className="flex items-center justify-between py-2.5 hover:text-primary">
                    <dt><Term help="Invoices you've sent that customers haven't paid yet (Accounts receivable).">Money owed to you</Term></dt>
                    <dd className="font-medium tabular-nums"><Money cents={toCents(data.owed.invoices_open_total)} />
                      <span className="ml-1 text-xs text-muted-foreground font-normal">({data.owed.invoices_open_count})</span></dd>
                  </Link>
                  <Link to="/invoices?status=outstanding" className="flex items-center justify-between py-2.5 hover:text-primary">
                    <dt className="pl-4 text-muted-foreground">of which overdue</dt>
                    <dd className={cn("tabular-nums", data.owed.invoices_overdue_count > 0 && "text-destructive font-medium")}>
                      <Money cents={toCents(data.owed.invoices_overdue_total)} />
                      <span className="ml-1 text-xs text-muted-foreground font-normal">({data.owed.invoices_overdue_count})</span></dd>
                  </Link>
                  <Link to="/expenses" className="flex items-center justify-between py-2.5 hover:text-primary">
                    <dt><Term help="Bills from suppliers you haven't paid yet (Accounts payable).">Money you owe</Term></dt>
                    <dd className="font-medium tabular-nums"><Money cents={toCents(data.owed.bills_open_total)} />
                      <span className="ml-1 text-xs text-muted-foreground font-normal">({data.owed.bills_open_count})</span></dd>
                  </Link>
                  <Link to="/expenses" className="flex items-center justify-between py-2.5 hover:text-primary">
                    <dt className="pl-4 text-muted-foreground">due within 7 days</dt>
                    <dd className="tabular-nums"><Money cents={toCents(data.owed.bills_due_soon_total)} />
                      <span className="ml-1 text-xs text-muted-foreground font-normal">({data.owed.bills_due_soon_count})</span></dd>
                  </Link>
                </dl>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Rows 3–4, or the getting-started checklist for a new business */}
        {fresh ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Get your books started</CardTitle>
              <CardDescription>Charts appear here once your first transactions are recorded.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-3 sm:grid-cols-3">
                {[
                  { n: 1, title: "Bring in your bank activity", body: "Upload a bank statement so your transactions can be reviewed.", to: "/bank-transactions", cta: "Go to Banking" },
                  { n: 2, title: "Add opening balances", body: "Record what each account held on the day your books start, as a journal entry.", to: "/journal-entries", cta: "Open journal entries", hide: !canKeepBooks },
                  { n: 3, title: "Send your first invoice", body: "Invoices post to your books automatically when you send them.", to: "/invoice/new", cta: "Create an invoice" },
                ].filter((s) => !s.hide).map((s) => (
                  <li key={s.n} className="rounded-lg border p-4 flex flex-col">
                    <div className="flex items-center gap-2 font-medium">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold">{s.n}</span>
                      {s.title}
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground flex-1">{s.body}</p>
                    <Button asChild variant="outline" size="sm" className="mt-3 self-start">
                      <Link to={s.to}>{s.cta}</Link>
                    </Button>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card className="lg:col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Income and expenses by month</CardTitle>
                  <CardDescription>The 12 months ending {shortDate(range.to)}</CardDescription>
                </CardHeader>
                <CardContent>
                  {!data ? <Skeleton className="h-[260px]" /> : !hasMonthly ? (
                    <p className="py-16 text-center text-sm text-muted-foreground">No income or expenses in these months.</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={monthly} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                        <YAxis tickLine={false} axisLine={false} width={56} tick={{ fontSize: 11 }}
                          tickFormatter={(v: number) => formatMoneyCompact(Math.round(v * 100))} />
                        <Tooltip formatter={(v: number) => formatMoney(Math.round(v * 100))} cursor={{ fill: "hsl(var(--muted))" }} />
                        <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="Income" fill="hsl(var(--chart-income))" radius={[3, 3, 0, 0]} />
                        <Bar dataKey="Expenses" fill="hsl(var(--chart-expense))" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Where the money went</CardTitle>
                  <CardDescription>Top expense accounts, {RANGE_LABELS[rangeKey].toLowerCase()}</CardDescription>
                </CardHeader>
                <CardContent>
                  {!data ? <Skeleton className="h-[260px]" /> : expenseSlices.length === 0 ? (
                    <p className="py-16 text-center text-sm text-muted-foreground">No expenses in this period.</p>
                  ) : (
                    <>
                      <ResponsiveContainer width="100%" height={160}>
                        <PieChart>
                          <Pie data={expenseSlices} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={1}>
                            {expenseSlices.map((_, i) => <Cell key={i} fill={EXPENSE_COLORS[i % EXPENSE_COLORS.length]} />)}
                          </Pie>
                          <Tooltip formatter={(v: number) => formatMoney(Math.round(v * 100))} />
                        </PieChart>
                      </ResponsiveContainer>
                      <ul className="mt-2 space-y-1 text-sm">
                        {expenseSlices.map((s, i) => (
                          <li key={s.name} className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: EXPENSE_COLORS[i % EXPENSE_COLORS.length] }} />
                              <span className="truncate">{s.name}</span>
                            </span>
                            <span className="tabular-nums text-muted-foreground"><Money cents={Math.round(s.value * 100)} /></span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Bank accounts</CardTitle>
                </CardHeader>
                <CardContent>
                  {!data ? <Skeleton className="h-24" /> : data.bank_accounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4">
                      No bank accounts yet. <Link to="/chart-of-accounts" className="text-primary underline-offset-2 hover:underline">Add one in your chart of accounts</Link>.
                    </p>
                  ) : (
                    <ul className="divide-y text-sm">
                      {data.bank_accounts.map((b) => {
                        const needs = !b.is_undeposited && (b.unreviewed > 0 || !b.last_reconciled);
                        return (
                          <li key={b.account_id} className="py-2.5">
                            <Link to={`/accounts/${b.account_id}/register`} className="flex items-center justify-between gap-3 hover:text-primary">
                              <span className="min-w-0">
                                <span className="font-medium truncate block">{b.name}</span>
                                <span className="text-xs text-muted-foreground">
                                  {b.is_undeposited
                                    ? "Payments received, not yet deposited"
                                    : b.last_reconciled ? `Reconciled through ${shortDate(b.last_reconciled)}` : "Never reconciled"}
                                </span>
                              </span>
                              <span className="text-right shrink-0">
                                <span className="block font-medium tabular-nums"><Money cents={toCents(b.book_balance)} /></span>
                                {needs && <Badge variant="outline" className="mt-0.5 border-warning/50 text-warning text-[11px]">Needs reconciling</Badge>}
                              </span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">Recent transactions</CardTitle>
                  <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
                    <Link to="/journal-entries">View all <ChevronRight className="h-3.5 w-3.5 ml-0.5" /></Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {!data ? <Skeleton className="h-24" /> : data.recent.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4">Nothing recorded yet.</p>
                  ) : (
                    <ul className="divide-y text-sm">
                      {data.recent.map((r) => (
                        <li key={r.entry_id}>
                          <button type="button" onClick={() => setSelectedEntry(r.entry_id)}
                            className="w-full flex items-center justify-between gap-3 py-2 text-left hover:text-primary">
                            <span className="flex items-center gap-3 min-w-0">
                              <span className="text-xs text-muted-foreground w-12 shrink-0">{shortDate(r.entry_date)}</span>
                              {r.source_type === "invoice" ? <Receipt className="h-4 w-4 text-muted-foreground shrink-0" />
                                : r.source_type === "payment" ? <Wallet className="h-4 w-4 text-muted-foreground shrink-0" />
                                : <Scale className="h-4 w-4 text-muted-foreground shrink-0" />}
                              <span className={cn("truncate", r.status === "voided" && "line-through text-muted-foreground")}>
                                {r.memo || r.entry_number}
                              </span>
                            </span>
                            <span className="tabular-nums shrink-0"><Money cents={toCents(r.amount)} /></span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>

      <JournalEntryDetailDialog entryId={selectedEntry} open={!!selectedEntry} onOpenChange={(o) => !o && setSelectedEntry(null)} />
    </Layout>
  );
};

export default BusinessHome;
