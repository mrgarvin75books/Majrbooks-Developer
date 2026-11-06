import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileSpreadsheet, History, Landmark, Trash2, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { formatMoney, toCents } from "@/lib/money";
import { ALL_CATEGORY_NAMES, categoryFor, computeSummary, type TxType } from "@/lib/scheduleC";
import { ImportStatementDialog } from "./ImportStatementDialog";

interface Props {
  clientId: string;
  clientName: string;
}

interface Line {
  id: string;
  txn_date: string;
  description: string;
  amount: number;
  direction: "in" | "out";
  type: TxType;
  category: string;
  notes: string;
  import_id: string | null;
}

const TYPE_LABELS: Record<TxType, string> = {
  income: "Income", expense: "Expense", transfer: "Transfer", personal: "Personal", needs_review: "Needs review",
};
const PAGE = 200;
const normDesc = (s: string) => s.toLowerCase().replace(/[0-9#*]+/g, " ").replace(/[^a-z]+/g, " ").trim();

/** Keeps type and category consistent for the non-business buckets. */
function reconcile(patch: Partial<Line>): Partial<Line> {
  const p = { ...patch };
  if (p.type === "transfer") p.category = "Transfer between accounts";
  if (p.type === "personal") p.category = "Owner draw or personal";
  if (p.type === "needs_review") p.category = "Needs review";
  if (p.category === "Transfer between accounts") p.type = "transfer";
  if (p.category === "Owner draw or personal") p.type = "personal";
  if (p.category === "Needs review") p.type = "needs_review";
  const def = p.category ? categoryFor(p.category) : null;
  if (def) p.type = def.kind === "income" ? "income" : "expense";
  return p;
}

export function ClientTransactionsCard({ clientId, clientName }: Props) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [year, setYear] = useState<number | null>(null);
  const [filter, setFilter] = useState<"all" | "needs_review">("all");
  const [shown, setShown] = useState(PAGE);
  const [importOpen, setImportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [undoId, setUndoId] = useState<string | null>(null);

  const { data: years = [], error: yearsError } = useQuery({
    queryKey: ["client-stmt-years", clientId],
    queryFn: async () => {
      const [{ data: first, error: e1 }, { data: last, error: e2 }] = await Promise.all([
        supabase.from("client_statement_transactions").select("txn_date").eq("client_id", clientId).order("txn_date").limit(1),
        supabase.from("client_statement_transactions").select("txn_date").eq("client_id", clientId).order("txn_date", { ascending: false }).limit(1),
      ]);
      if (e1 || e2) throw e1 ?? e2;
      if (!first?.length || !last?.length) return [];
      const a = Number(first[0].txn_date.slice(0, 4));
      const b = Number(last[0].txn_date.slice(0, 4));
      return Array.from({ length: b - a + 1 }, (_, i) => b - i);
    },
  });
  const activeYear = year ?? years[0] ?? null;

  const { data: lines = [], isLoading } = useQuery({
    queryKey: ["client-stmt-lines", clientId, activeYear],
    enabled: activeYear !== null,
    queryFn: async () => {
      const all: Line[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from("client_statement_transactions")
          .select("id, txn_date, description, amount, direction, type, category, notes, import_id")
          .eq("client_id", clientId)
          .gte("txn_date", `${activeYear}-01-01`).lte("txn_date", `${activeYear}-12-31`)
          .order("txn_date", { ascending: false }).order("id")
          .range(from, from + 999);
        if (error) throw error;
        all.push(...((data ?? []) as Line[]));
        if (!data || data.length < 1000) break;
      }
      return all;
    },
  });

  const { data: imports = [] } = useQuery({
    queryKey: ["client-stmt-imports", clientId],
    enabled: historyOpen,
    queryFn: async () => {
      const { data, error } = await supabase.from("client_statement_imports")
        .select("id, file_name, created_at, imported_count, duplicate_count, period_start, period_end")
        .eq("client_id", clientId).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["client-stmt-years", clientId] });
    qc.invalidateQueries({ queryKey: ["client-stmt-lines", clientId] });
    qc.invalidateQueries({ queryKey: ["client-stmt-imports", clientId] });
  };

  const summary = useMemo(() => computeSummary(lines.map((l) => ({
    date: l.txn_date, description: l.description, amount: Number(l.amount), category: l.category, type: l.type, notes: l.notes,
  }))), [lines]);
  const visible = filter === "needs_review" ? lines.filter((l) => l.type === "needs_review") : lines;

  const save = async (ids: string[], patch: Partial<Line>) => {
    const p = reconcile(patch);
    qc.setQueryData<Line[]>(["client-stmt-lines", clientId, activeYear], (old) => old?.map((l) => (ids.includes(l.id) ? { ...l, ...p } : l)));
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await supabase.from("client_statement_transactions")
        .update({ type: p.type, category: p.category }).in("id", ids.slice(i, i + 200));
      if (error) {
        toast.error(`Couldn't save: ${error.message}`);
        refresh();
        return;
      }
    }
  };

  const change = async (line: Line, patch: Partial<Line>) => {
    await save([line.id], patch);
    const p = reconcile(patch);
    const key = normDesc(line.description);
    const similar = lines.filter((l) => l.id !== line.id && l.direction === line.direction && normDesc(l.description) === key && l.category !== p.category);
    if (key && similar.length) {
      toast(`${similar.length} more "${line.description.slice(0, 40)}" transaction${similar.length === 1 ? "" : "s"}`, {
        description: `Set them to ${p.category} too?`,
        action: { label: "Apply to all", onClick: () => save(similar.map((s) => s.id), patch) },
        duration: 10_000,
      });
    }
  };

  const undoImport = async () => {
    if (!undoId) return;
    const { error } = await supabase.from("client_statement_imports").delete().eq("id", undoId);
    setUndoId(null);
    if (error) { toast.error(error.message); return; }
    toast.success("Import removed");
    refresh();
  };

  const notReady = yearsError && /does not exist|could not find the table/i.test((yearsError as Error).message);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><Landmark className="h-5 w-5" /> Bank transactions</CardTitle>
            <CardDescription>Imported from this client's bank statements. Kept separate from your firm's own books.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setImportOpen(true)} disabled={!!notReady}><Upload className="h-4 w-4 mr-2" /> Import Excel / CSV</Button>
            {lines.length > 0 && (
              <Button variant="outline" onClick={() => navigate(`/schedule-c?client=${clientId}&year=${activeYear}`)}>
                <FileSpreadsheet className="h-4 w-4 mr-2" /> P&amp;L and Schedule C
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={() => setHistoryOpen((o) => !o)} aria-label="Import history"><History className="h-4 w-4" /></Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {notReady && (
          <Alert><AlertDescription>Statement imports need a database update that hasn't been installed yet.</AlertDescription></Alert>
        )}

        {historyOpen && (
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-sm font-medium">Import history</p>
            {imports.length === 0 ? <p className="text-sm text-muted-foreground">No imports yet.</p> : (
              <ul className="divide-y text-sm">
                {imports.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{i.file_name}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(i.created_at).toLocaleDateString()} · {i.imported_count} added{i.duplicate_count ? `, ${i.duplicate_count} skipped` : ""}
                        {i.period_start ? ` · ${i.period_start} to ${i.period_end}` : ""}
                      </span>
                    </span>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setUndoId(i.id)}>
                      <Trash2 className="h-4 w-4 mr-1" /> Undo
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!notReady && years.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">No bank transactions yet</p>
            <p>Download the client's statement from their bank as Excel or CSV and import it here.</p>
          </div>
        ) : !notReady && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={activeYear ? String(activeYear) : ""} onValueChange={(v) => { setYear(Number(v)); setShown(PAGE); }}>
                <SelectTrigger className="w-[130px]"><SelectValue placeholder="Year" /></SelectTrigger>
                <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={filter} onValueChange={(v) => { setFilter(v as typeof filter); setShown(PAGE); }}>
                <SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All transactions ({lines.length})</SelectItem>
                  <SelectItem value="needs_review">Needs review ({summary.excluded.needsReviewCount})</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-2 ml-auto text-sm">
                <Badge variant="outline">Income {formatMoney(summary.pnl.totalIncome)}</Badge>
                <Badge variant="outline">Expenses {formatMoney(summary.pnl.totalExpenses + summary.pnl.cogs)}</Badge>
                <Badge>Net {formatMoney(summary.pnl.netProfit, { parentheses: true })}</Badge>
              </div>
            </div>

            {summary.excluded.needsReviewCount > 0 && filter === "all" && (
              <p className="text-sm text-yellow-700">
                {summary.excluded.needsReviewCount} transaction{summary.excluded.needsReviewCount === 1 ? "" : "s"} need a category before they count in the totals.{" "}
                <button type="button" className="underline" onClick={() => setFilter("needs_review")}>Show them</button>
              </p>
            )}

            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Type</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">Loading…</TableCell></TableRow>
                  ) : visible.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">Nothing here.</TableCell></TableRow>
                  ) : visible.slice(0, shown).map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap">{l.txn_date}</TableCell>
                      <TableCell className="max-w-[260px]">
                        <span className="block truncate" title={l.description}>{l.description}</span>
                        {l.notes && <span className="block truncate text-xs text-muted-foreground" title={l.notes}>{l.notes}</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono whitespace-nowrap">{l.direction === "in" ? formatMoney(toCents(l.amount)) : ""}</TableCell>
                      <TableCell className="text-right font-mono whitespace-nowrap">{l.direction === "out" ? formatMoney(toCents(l.amount)) : ""}</TableCell>
                      <TableCell className="min-w-[210px]">
                        <Select value={l.category} onValueChange={(v) => change(l, { category: v })}>
                          <SelectTrigger className="h-8 text-xs" aria-label={`Category for ${l.description}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {(ALL_CATEGORY_NAMES.includes(l.category) ? ALL_CATEGORY_NAMES : [l.category, ...ALL_CATEGORY_NAMES]).map((c) => (
                              <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="min-w-[130px]">
                        <Select value={l.type} onValueChange={(v) => change(l, { type: v as TxType })}>
                          <SelectTrigger className="h-8 text-xs" aria-label={`Type for ${l.description}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {(Object.keys(TYPE_LABELS) as TxType[]).map((t) => <SelectItem key={t} value={t} className="text-xs">{TYPE_LABELS[t]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {visible.length > shown && (
              <Button variant="outline" size="sm" onClick={() => setShown((s) => s + PAGE)}>Show more ({visible.length - shown} left)</Button>
            )}
          </>
        )}
      </CardContent>

      <ImportStatementDialog open={importOpen} onOpenChange={setImportOpen} clientId={clientId} clientName={clientName} onImported={refresh} />

      <AlertDialog open={!!undoId} onOpenChange={(o) => !o && setUndoId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this import?</AlertDialogTitle>
            <AlertDialogDescription>
              Every transaction added by this file is removed, including any categories you changed on them. You can import the file again afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={undoImport} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Remove import</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
