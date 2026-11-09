import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ledgerErrorMessage, useCurrentBusiness } from "@/hooks/useCurrentBusiness";
import { formatMoney, sumCents, toCents } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";

interface JournalEntryDetailDialogProps {
  entryId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}

interface Entry {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string | null;
  reference: string | null;
  status: string;
  source_type: string | null;
  is_legacy: boolean;
  reverses_entry_id: string | null;
  voided_by_entry_id: string | null;
  void_reason: string | null;
  posted_at: string | null;
}

interface Line {
  id: string;
  line_no: number | null;
  debit: number | string;
  credit: number | string;
  description: string | null;
  chart_of_accounts: { name: string; account_number: string | null; account_class: string | null } | null;
}

type Mode = "view" | "void" | "reverse";

export const statusLabel = (e: Pick<Entry, "status" | "reverses_entry_id">) =>
  e.status === "voided" ? "Voided" : e.status === "draft" ? "Draft" : e.reverses_entry_id ? "Reversal" : "Posted";

const sourceLabel = (e: Entry) => {
  switch (e.source_type) {
    case "invoice": return `Invoice ${e.reference ?? ""}`.trim();
    case "payment": return `Payment for invoice ${e.reference ?? ""}`.trim();
    default: return "Manual entry";
  }
};

const JournalEntryDetailDialog = ({ entryId, open, onOpenChange, onChanged }: JournalEntryDetailDialogProps) => {
  const { toast } = useToast();
  const { canKeepBooks, business } = useCurrentBusiness();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("view");
  const [reason, setReason] = useState("");
  const [reversalDate, setReversalDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!entryId) return;
    setLoading(true);
    setError(null);
    const [{ data: e, error: eErr }, { data: l, error: lErr }] = await Promise.all([
      supabase.from("journal_entries")
        .select("id, entry_number, entry_date, description, reference, status, source_type, is_legacy, reverses_entry_id, voided_by_entry_id, void_reason, posted_at")
        .eq("id", entryId).maybeSingle(),
      supabase.from("journal_entry_lines")
        .select("id, line_no, debit, credit, description, chart_of_accounts(name, account_number, account_class)")
        .eq("journal_entry_id", entryId)
        .order("line_no", { ascending: true, nullsFirst: false }),
    ]);
    setLoading(false);
    if (eErr || lErr) {
      setError(ledgerErrorMessage(eErr ?? lErr));
      return;
    }
    setEntry(e as Entry | null);
    setLines((l ?? []) as Line[]);
  };

  useEffect(() => {
    if (entryId && open) {
      setMode("view");
      setReason("");
      setReversalDate("");
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, open]);

  const run = async (action: () => PromiseLike<{ error: unknown }>, success: string, close = false) => {
    setBusy(true);
    setError(null);
    const { error: err } = await action();
    setBusy(false);
    if (err) {
      setError(ledgerErrorMessage(err));
      return;
    }
    toast({ title: success });
    onChanged?.();
    if (close) onOpenChange(false);
    else {
      setMode("view");
      load();
    }
  };

  const totalDebit = sumCents(lines.map((l) => toCents(l.debit)));
  const totalCredit = sumCents(lines.map((l) => toCents(l.credit)));
  const isManual = !entry?.source_type || entry.source_type === "manual";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Journal entry {entry?.entry_number ?? ""}</DialogTitle>
          {entry?.is_legacy && (
            <DialogDescription>Recorded before the accounting engine was introduced.</DialogDescription>
          )}
        </DialogHeader>

        {loading || !entry ? (
          <div className="text-center py-8 text-muted-foreground">{loading ? "Loading…" : error ?? "Entry not found."}</div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">Date</div>
                <div className="font-medium">{entry.entry_date}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Status</div>
                <Badge variant={entry.status === "posted" ? "default" : entry.status === "voided" ? "destructive" : "secondary"}>
                  {statusLabel(entry)}
                </Badge>
              </div>
              <div>
                <div className="text-muted-foreground">Source</div>
                <div className="font-medium">{sourceLabel(entry)}</div>
              </div>
              {entry.reference && (
                <div>
                  <div className="text-muted-foreground">Reference</div>
                  <div className="font-medium">{entry.reference}</div>
                </div>
              )}
              {entry.description && (
                <div className="col-span-2">
                  <div className="text-muted-foreground">Memo</div>
                  <div className="font-medium">{entry.description}</div>
                </div>
              )}
              {entry.status === "voided" && entry.void_reason && (
                <div className="col-span-2">
                  <div className="text-muted-foreground">Void reason</div>
                  <div className="font-medium">{entry.void_reason}</div>
                </div>
              )}
            </div>

            <Separator />

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">
                      {l.chart_of_accounts?.account_number ? `${l.chart_of_accounts.account_number} · ` : ""}
                      {l.chart_of_accounts?.name ?? "Unknown account"}
                    </TableCell>
                    <TableCell>{l.description || "—"}</TableCell>
                    <TableCell className="text-right">{toCents(l.debit) > 0 ? formatMoney(toCents(l.debit)) : ""}</TableCell>
                    <TableCell className="text-right">{toCents(l.credit) > 0 ? formatMoney(toCents(l.credit)) : ""}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-semibold bg-muted/50">
                  <TableCell colSpan={2}>Total</TableCell>
                  <TableCell className="text-right">{formatMoney(totalDebit)}</TableCell>
                  <TableCell className="text-right">{formatMoney(totalCredit)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            {totalDebit !== totalCredit && (
              <p className="text-sm text-destructive text-right">
                Unbalanced by {formatMoney(Math.abs(totalDebit - totalCredit))}
                {entry.status === "draft" ? " — fix before posting." : " (recorded before balance checks existed)."}
              </p>
            )}

            {error && (
              <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
            )}

            {canKeepBooks && mode === "void" && (
              <div className="space-y-2 rounded-md border p-4">
                <Label htmlFor="void-reason">Why are you voiding this entry?</Label>
                <Input id="void-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
                <p className="text-xs text-muted-foreground">
                  A reversing entry is posted on the same date. The original stays in the history.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setMode("view")} disabled={busy}>Back</Button>
                  <Button variant="destructive" disabled={busy || !reason.trim()}
                    onClick={() => run(() => supabase.rpc("void_journal_entry", { p_entry_id: entry.id, p_reason: reason }), "Entry voided")}>
                    Void entry
                  </Button>
                </div>
              </div>
            )}

            {canKeepBooks && mode === "reverse" && (
              <div className="space-y-2 rounded-md border p-4">
                <Label htmlFor="reverse-date">Reversal date</Label>
                <Input id="reverse-date" type="date" value={reversalDate} onChange={(e) => setReversalDate(e.target.value)}
                  min={business?.lock_date ?? undefined} />
                <p className="text-xs text-muted-foreground">
                  Posts the mirror of this entry on the chosen date — for example to reverse an accrual next month.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setMode("view")} disabled={busy}>Back</Button>
                  <Button disabled={busy || !reversalDate}
                    onClick={() => run(() => supabase.rpc("reverse_journal_entry", { p_entry_id: entry.id, p_reversal_date: reversalDate }), "Reversing entry posted")}>
                    Post reversal
                  </Button>
                </div>
              </div>
            )}

            {canKeepBooks && mode === "view" && (
              <div className="flex flex-wrap justify-end gap-2">
                {entry.status === "draft" && (
                  <>
                    <Button variant="outline" disabled={busy}
                      onClick={() => run(() => supabase.rpc("delete_draft_entry", { p_entry_id: entry.id }), "Draft deleted", true)}>
                      Delete draft
                    </Button>
                    <Button disabled={busy || totalDebit !== totalCredit}
                      onClick={() => run(() => supabase.rpc("post_draft_entry", { p_entry_id: entry.id }), "Entry posted")}>
                      Post entry
                    </Button>
                  </>
                )}
                {entry.status === "posted" && isManual && !entry.reverses_entry_id && (
                  <>
                    <Button variant="outline" onClick={() => setMode("reverse")}>Reverse…</Button>
                    <Button variant="destructive" onClick={() => setMode("void")}>Void…</Button>
                  </>
                )}
                {entry.status === "posted" && !isManual && (
                  <p className="text-sm text-muted-foreground">
                    Created by a {entry.source_type}. To correct it, edit or cancel the {entry.source_type}.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default JournalEntryDetailDialog;
