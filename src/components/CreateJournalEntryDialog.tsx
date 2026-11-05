import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ledgerErrorMessage, useCurrentBusiness } from "@/hooks/useCurrentBusiness";
import { centsToDecimalString, formatMoney, parseMoney, validateJournalLines, type JournalLineInput } from "@/lib/money";
import { Plus, Trash2 } from "lucide-react";

interface CreateJournalEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const blankLine = (): JournalLineInput => ({ account_id: "", description: "", debit: "", credit: "" });
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Manual journal entry. Submits to the post_journal_entry database function,
 * which validates and writes the whole entry in one transaction — a failure
 * can never leave a partial entry.
 */
const CreateJournalEntryDialog = ({ open, onOpenChange, onSuccess }: CreateJournalEntryDialogProps) => {
  const { toast } = useToast();
  const { business, canKeepBooks } = useCurrentBusiness();
  const [entryDate, setEntryDate] = useState(today());
  const [memo, setMemo] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<JournalLineInput[]>([blankLine(), blankLine()]);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // One key per dialog session: a double-click or retry can't post twice (V8).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (open) {
      setEntryDate(today());
      setMemo("");
      setReference("");
      setLines([blankLine(), blankLine()]);
      setServerError(null);
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [open]);

  const { data: accounts = [] } = useQuery({
    queryKey: ["ledger-accounts", business?.business_id],
    enabled: open && !!business,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("chart_of_accounts")
        .select("id, name, account_number, account_class")
        .eq("business_id", business!.business_id)
        .eq("is_active", true)
        .is("archived_at", null)
        .not("account_class", "is", null)
        .order("account_number", { nullsFirst: false })
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const validation = useMemo(() => validateJournalLines(lines), [lines]);
  const lockDate = business?.lock_date ?? null;
  const dateLocked = !!lockDate && entryDate <= lockDate;

  const updateLine = (index: number, field: keyof JournalLineInput, value: string) => {
    setLines((prev) => {
      const next = [...prev];
      const updated = { ...next[index], [field]: value };
      // Typing in one amount column clears the other (a line is a debit OR a credit).
      if (field === "debit" && value.trim()) updated.credit = "";
      if (field === "credit" && value.trim()) updated.debit = "";
      next[index] = updated;
      return next;
    });
  };

  const submit = async (asDraft: boolean) => {
    if (!business) return;
    setServerError(null);
    if (!asDraft && !validation.ok) return;

    const payload = lines
      .filter((l) => l.account_id || l.debit.trim() || l.credit.trim())
      .map((l) => ({
        account_id: l.account_id,
        debit: centsToDecimalString(l.debit.trim() ? parseMoney(l.debit) ?? 0 : 0),
        credit: centsToDecimalString(l.credit.trim() ? parseMoney(l.credit) ?? 0 : 0),
        description: l.description?.trim() || null,
      }));

    setSaving(true);
    const { error } = await supabase.rpc("post_journal_entry", {
      p_business_id: business.business_id,
      p_entry_date: entryDate,
      p_memo: memo,
      p_reference: reference,
      p_lines: payload,
      p_idempotency_key: idempotencyKey,
      p_as_draft: asDraft,
    });
    setSaving(false);

    if (error) {
      setServerError(ledgerErrorMessage(error));
      return;
    }
    toast({
      title: asDraft ? "Draft saved" : "Journal entry posted",
      description: asDraft ? "It won't affect your books until you post it." : `${formatMoney(validation.totalDebit)} posted to the ledger.`,
    });
    onOpenChange(false);
    onSuccess();
  };

  if (!canKeepBooks) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New journal entry</DialogTitle>
            <DialogDescription>
              Only the business owner and its accountants can record journal entries.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New journal entry</DialogTitle>
          <DialogDescription>
            Each line is either a debit or a credit. The entry can be posted only when total debits equal total credits.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="je-date">Date</Label>
              <Input id="je-date" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
              {dateLocked && (
                <p className="text-xs text-destructive">
                  The books are closed through {lockDate}. Choose a later date or save as a draft.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="je-ref">Reference (optional)</Label>
              <Input id="je-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="je-memo">Memo</Label>
            <Textarea id="je-memo" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={1000}
              placeholder="What is this entry for? (e.g. December depreciation)" />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Lines</h3>
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((p) => [...p, blankLine()])}>
                <Plus className="h-4 w-4 mr-1" /> Add line
              </Button>
            </div>

            <div className="hidden sm:grid grid-cols-12 gap-2 text-xs font-medium text-muted-foreground px-1">
              <div className="col-span-4">Account</div>
              <div className="col-span-3">Description</div>
              <div className="col-span-2 text-right">Debit</div>
              <div className="col-span-2 text-right">Credit</div>
            </div>

            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-12 gap-2 items-start">
                <div className="col-span-12 sm:col-span-4">
                  <Select value={line.account_id} onValueChange={(v) => updateLine(index, "account_id", v)}>
                    <SelectTrigger aria-label={`Account for line ${index + 1}`}>
                      <SelectValue placeholder="Choose account" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.account_number ? `${a.account_number} · ` : ""}{a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-12 sm:col-span-3">
                  <Input placeholder="Description" value={line.description}
                    onChange={(e) => updateLine(index, "description", e.target.value)} />
                </div>
                <div className="col-span-5 sm:col-span-2">
                  <Input inputMode="decimal" placeholder="0.00" className="text-right" aria-label={`Debit for line ${index + 1}`}
                    value={line.debit} onChange={(e) => updateLine(index, "debit", e.target.value)} />
                </div>
                <div className="col-span-5 sm:col-span-2">
                  <Input inputMode="decimal" placeholder="0.00" className="text-right" aria-label={`Credit for line ${index + 1}`}
                    value={line.credit} onChange={(e) => updateLine(index, "credit", e.target.value)} />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${index + 1}`}
                    onClick={() => setLines((p) => p.filter((_, i) => i !== index))} disabled={lines.length <= 2}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}

            <div className="flex flex-wrap justify-end gap-6 pt-3 border-t text-sm">
              <div><span className="font-semibold">Debits:</span> {formatMoney(validation.totalDebit)}</div>
              <div><span className="font-semibold">Credits:</span> {formatMoney(validation.totalCredit)}</div>
              <div className={validation.difference === 0 && validation.totalDebit > 0 ? "text-green-600 font-semibold" : "text-destructive font-semibold"}>
                {validation.difference === 0 && validation.totalDebit > 0
                  ? "✓ Balanced"
                  : `Difference ${formatMoney(Math.abs(validation.difference))}`}
              </div>
            </div>
          </div>

          {(serverError || (!validation.ok && validation.totalDebit + validation.totalCredit > 0)) && (
            <Alert variant="destructive">
              <AlertDescription>
                {serverError ?? validation.errors[0]}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="button" variant="secondary" onClick={() => submit(true)} disabled={saving}>
              Save as draft
            </Button>
            <Button type="button" onClick={() => submit(false)} disabled={saving || !validation.ok || dateLocked}>
              {saving ? "Posting…" : "Post entry"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default CreateJournalEntryDialog;
