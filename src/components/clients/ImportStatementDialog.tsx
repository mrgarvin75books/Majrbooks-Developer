import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { formatMoney } from "@/lib/money";
import {
  detectColumns, findHeaderRow, fingerprints, parseLines,
  type Cell, type ColumnMapping, type SignConvention,
} from "@/lib/statementImport";
import { categorize } from "@/lib/categorizeRules";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  clientName: string;
  onImported: () => void;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 20_000;
const NONE = "__none__";

type Summary = { added: number; duplicates: number; errors: number };

/**
 * Imports a client's bank statement from Excel or CSV — no AI. Columns are
 * detected automatically and can be corrected; lines are categorised by
 * rules; lines already imported are skipped.
 */
export function ImportStatementDialog({ open, onOpenChange, clientId, clientName, onImported }: Props) {
  const [fileName, setFileName] = useState("");
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [sheet, setSheet] = useState("");
  const [rows, setRows] = useState<Cell[][]>([]);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping>({ date: null, description: null, amount: null, debit: null, credit: null });
  const [sign, setSign] = useState<SignConvention>("negative_is_out");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<Summary | null>(null);

  const reset = () => {
    setFileName(""); setWorkbook(null); setSheet(""); setRows([]); setHeaderRow(0);
    setMapping({ date: null, description: null, amount: null, debit: null, credit: null });
    setSign("negative_is_out"); setError(null); setDone(null); setSaving(false);
  };

  const loadSheet = (wb: XLSX.WorkBook, name: string) => {
    const data = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    if (data.length > MAX_ROWS) {
      setError(`This sheet has ${data.length.toLocaleString()} rows. Split it into files of up to ${MAX_ROWS.toLocaleString()} rows.`);
      return;
    }
    const h = findHeaderRow(data);
    setSheet(name);
    setRows(data);
    setHeaderRow(h);
    setMapping(detectColumns(data[h] ?? []));
  };

  const onFile = async (file: File | undefined) => {
    reset();
    if (!file) return;
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) { setError("Choose an Excel (.xlsx, .xls) or CSV file."); return; }
    if (file.size > MAX_FILE_BYTES) { setError("That file is larger than 10 MB. Split it into smaller periods."); return; }
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true, raw: false });
      if (!wb.SheetNames.length) { setError("This file has no sheets."); return; }
      setFileName(file.name);
      setWorkbook(wb);
      loadSheet(wb, wb.SheetNames[0]);
    } catch {
      setError("This file couldn't be read. If it's from your bank, try downloading it again as CSV or Excel.");
    }
  };

  const parsed = useMemo(() => (rows.length ? parseLines(rows, headerRow, mapping, sign) : null), [rows, headerRow, mapping, sign]);
  const prepared = useMemo(() => {
    if (!parsed) return [];
    const keys = fingerprints(parsed.lines);
    return parsed.lines.map((l, i) => ({ ...l, ...categorize(l.description, l.direction), fingerprint: keys[i] }));
  }, [parsed]);

  const header = rows[headerRow] ?? [];
  const colOptions = header.map((h, i) => ({ value: String(i), label: `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}: ${String(h ?? "").slice(0, 30) || "(blank)"}` }));
  const singleAmount = mapping.amount !== null;
  const mappingOk = mapping.date !== null && (mapping.amount !== null || mapping.debit !== null || mapping.credit !== null);
  const period = prepared.length ? { start: prepared.reduce((a, l) => (l.date < a ? l.date : a), prepared[0].date), end: prepared.reduce((a, l) => (l.date > a ? l.date : a), prepared[0].date) } : null;
  const totals = prepared.reduce((t, l) => (l.direction === "in" ? { ...t, in: t.in + l.cents } : { ...t, out: t.out + l.cents }), { in: 0, out: 0 });
  const review = prepared.filter((l) => l.type === "needs_review").length;

  const setCol = (key: keyof ColumnMapping) => (v: string) => setMapping((m) => ({ ...m, [key]: v === NONE ? null : Number(v) }));

  const importNow = async () => {
    if (!prepared.length) return;
    setSaving(true);
    setError(null);
    try {
      const { data: batch, error: batchErr } = await supabase
        .from("client_statement_imports")
        .insert({ client_id: clientId, file_name: fileName.slice(0, 255), sheet_name: sheet, row_count: prepared.length, period_start: period?.start ?? null, period_end: period?.end ?? null })
        .select("id")
        .single();
      if (batchErr) throw batchErr;

      // Find which lines are already saved for this client, then insert the rest.
      const existing = new Set<string>();
      const keys = prepared.map((l) => l.fingerprint);
      for (let i = 0; i < keys.length; i += 500) {
        const { data, error: e } = await supabase.from("client_statement_transactions").select("fingerprint")
          .eq("client_id", clientId).in("fingerprint", keys.slice(i, i + 500));
        if (e) throw e;
        data?.forEach((d) => existing.add(d.fingerprint));
      }
      const fresh = prepared.filter((l) => !existing.has(l.fingerprint));
      for (let i = 0; i < fresh.length; i += 500) {
        const { error: e } = await supabase.from("client_statement_transactions").upsert(
          fresh.slice(i, i + 500).map((l) => ({
            client_id: clientId,
            import_id: batch.id,
            txn_date: l.date,
            description: l.description,
            amount: l.cents / 100,
            direction: l.direction,
            type: l.type,
            category: l.category,
            notes: l.notes,
            fingerprint: l.fingerprint,
          })),
          { onConflict: "client_id,fingerprint", ignoreDuplicates: true },
        );
        if (e) throw e;
      }
      await supabase.from("client_statement_imports")
        .update({ imported_count: fresh.length, duplicate_count: prepared.length - fresh.length })
        .eq("id", batch.id);

      setDone({ added: fresh.length, duplicates: prepared.length - fresh.length, errors: parsed?.errors.length ?? 0 });
      onImported();
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? "Import failed";
      setError(/relation .* does not exist|could not find the table/i.test(msg)
        ? "The database isn't ready for statement imports yet (the update for this feature hasn't been installed)."
        : msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import bank statement for {clientName}</DialogTitle>
          <DialogDescription>
            Upload the statement as Excel or CSV (download it from the bank's website). Lines already imported are skipped automatically.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-2 text-lg font-medium"><CheckCircle2 className="h-6 w-6 text-green-600" /> Import complete</div>
            <ul className="text-sm space-y-1">
              <li><strong>{done.added}</strong> new transaction{done.added === 1 ? "" : "s"} added</li>
              {done.duplicates > 0 && <li><strong>{done.duplicates}</strong> already imported before, skipped</li>}
              {done.errors > 0 && <li className="text-destructive"><strong>{done.errors}</strong> row{done.errors === 1 ? "" : "s"} couldn't be read and were left out</li>}
            </ul>
            <div className="flex gap-2">
              <Button onClick={() => onOpenChange(false)}>Done</Button>
              <Button variant="outline" onClick={reset}>Import another file</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer hover:bg-muted/40">
              <Upload className="h-8 w-8 text-muted-foreground" />
              <span className="text-sm font-medium">{fileName || "Click to choose an Excel or CSV file"}</span>
              <span className="text-xs text-muted-foreground">.xlsx, .xls or .csv · up to 10 MB</span>
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>

            {error && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{error}</AlertDescription></Alert>}

            {workbook && rows.length > 0 && (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {workbook.SheetNames.length > 1 && (
                    <div className="space-y-1">
                      <Label>Sheet</Label>
                      <Select value={sheet} onValueChange={(v) => loadSheet(workbook, v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{workbook.SheetNames.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label>Header row</Label>
                    <Select value={String(headerRow)} onValueChange={(v) => { const h = Number(v); setHeaderRow(h); setMapping(detectColumns(rows[h] ?? [])); }}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {rows.slice(0, 25).map((r, i) => (
                          <SelectItem key={i} value={String(i)}>Row {i + 1}: {r.filter((c) => c !== null && c !== "").slice(0, 3).map(String).join(" · ").slice(0, 40) || "(empty)"}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {(["date", "description"] as const).map((k) => (
                    <div key={k} className="space-y-1">
                      <Label className="capitalize">{k} column</Label>
                      <Select value={mapping[k] === null ? NONE : String(mapping[k])} onValueChange={setCol(k)}>
                        <SelectTrigger><SelectValue placeholder="Choose column" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>(none)</SelectItem>
                          {colOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                  <div className="space-y-1">
                    <Label>Amounts are in</Label>
                    <Select value={singleAmount ? "single" : "split"} onValueChange={(v) => setMapping((m) => v === "single"
                      ? { ...m, amount: m.amount ?? m.debit ?? m.credit, debit: null, credit: null }
                      : { ...m, debit: m.debit ?? m.amount, credit: m.credit, amount: null })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="single">One amount column</SelectItem>
                        <SelectItem value="split">Separate money in / money out columns</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {singleAmount ? (
                    <>
                      <div className="space-y-1">
                        <Label>Amount column</Label>
                        <Select value={mapping.amount === null ? NONE : String(mapping.amount)} onValueChange={setCol("amount")}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>{colOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label>Money going out is shown as</Label>
                        <Select value={sign} onValueChange={(v) => setSign(v as SignConvention)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="negative_is_out">Negative numbers (most banks)</SelectItem>
                            <SelectItem value="positive_is_out">Positive numbers</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  ) : (
                    (["debit", "credit"] as const).map((k) => (
                      <div key={k} className="space-y-1">
                        <Label>{k === "debit" ? "Money out column" : "Money in column"}</Label>
                        <Select value={mapping[k] === null ? NONE : String(mapping[k])} onValueChange={setCol(k)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>(none)</SelectItem>
                            {colOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    ))
                  )}
                </div>

                {!mappingOk ? (
                  <Alert><AlertDescription>Choose the date column and the amount column(s) to see the preview.</AlertDescription></Alert>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2 text-sm">
                      <Badge variant="secondary"><FileSpreadsheet className="h-3 w-3 mr-1" />{prepared.length} transactions</Badge>
                      {period && <Badge variant="outline">{period.start} to {period.end}</Badge>}
                      <Badge variant="outline">In {formatMoney(totals.in)}</Badge>
                      <Badge variant="outline">Out {formatMoney(totals.out)}</Badge>
                      {review > 0 && <Badge variant="outline" className="border-yellow-500 text-yellow-700">{review} to review after import</Badge>}
                    </div>

                    {parsed && parsed.errors.length > 0 && (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription>
                          {parsed.errors.length} row{parsed.errors.length === 1 ? "" : "s"} can't be read and will be left out:{" "}
                          {parsed.errors.slice(0, 5).map((e) => `row ${e.row} (${e.reason})`).join("; ")}{parsed.errors.length > 5 ? "…" : ""}
                        </AlertDescription>
                      </Alert>
                    )}

                    <div className="rounded-md border overflow-x-auto max-h-[320px]">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Date</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead className="text-right">In</TableHead>
                            <TableHead className="text-right">Out</TableHead>
                            <TableHead>Suggested category</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {prepared.slice(0, 50).map((l) => (
                            <TableRow key={l.fingerprint}>
                              <TableCell className="whitespace-nowrap">{l.date}</TableCell>
                              <TableCell className="max-w-[280px] truncate">{l.description}</TableCell>
                              <TableCell className="text-right font-mono">{l.direction === "in" ? formatMoney(l.cents) : ""}</TableCell>
                              <TableCell className="text-right font-mono">{l.direction === "out" ? formatMoney(l.cents) : ""}</TableCell>
                              <TableCell className={l.type === "needs_review" ? "text-yellow-700" : undefined}>{l.category}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {prepared.length > 50 && <p className="text-xs text-muted-foreground">Showing the first 50 of {prepared.length}.</p>}
                    <p className="text-xs text-muted-foreground">
                      Check a few lines: money in should be deposits and money out should be payments. If they're the wrong way round, change "Money going out is shown as".
                    </p>

                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
                      <Button onClick={importNow} disabled={saving || prepared.length === 0}>
                        {saving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Importing…</> : `Import ${prepared.length} transactions`}
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
