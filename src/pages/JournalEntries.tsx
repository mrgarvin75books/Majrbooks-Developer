import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import Layout from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FileText, Lock, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ledgerErrorMessage, useCurrentBusiness } from "@/hooks/useCurrentBusiness";
import CreateJournalEntryDialog from "@/components/CreateJournalEntryDialog";
import JournalEntryDetailDialog, { statusLabel } from "@/components/JournalEntryDetailDialog";

interface EntryRow {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string | null;
  reference: string | null;
  status: string;
  source_type: string | null;
  source_id: string | null;
  reverses_entry_id: string | null;
  is_legacy: boolean;
}

const PAGE_SIZE = 100;

const LockDateCard = () => {
  const { business, canKeepBooks, refetch } = useCurrentBusiness();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!business) return null;

  const current = business.lock_date;
  const reopening = !!current && (!date || date < current);

  const save = async () => {
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.rpc("set_lock_date", {
      p_business_id: business.business_id,
      p_lock_date: date || null,
      p_reason: reason || null,
    });
    setSaving(false);
    if (err) {
      setError(ledgerErrorMessage(err));
      return;
    }
    toast({ title: date ? `Books closed through ${date}` : "Books reopened" });
    setEditing(false);
    refetch();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><Lock className="h-4 w-4" /> Closed periods</CardTitle>
        <CardDescription>
          {current
            ? <>Books are closed through <strong>{current}</strong>. Nothing dated on or before then can be posted or changed.</>
            : "No period is closed yet. After you finish a month, close it so nothing earlier can change by accident."}
        </CardDescription>
      </CardHeader>
      {canKeepBooks && (
        <CardContent>
          {!editing ? (
            <Button variant="outline" size="sm" onClick={() => { setDate(current ?? ""); setReason(""); setError(null); setEditing(true); }}>
              Change lock date
            </Button>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[200px_1fr_auto] items-end">
              <div className="space-y-1">
                <Label htmlFor="lock-date">Closed through</Label>
                <Input id="lock-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lock-reason">Reason {reopening ? "(required to reopen)" : "(optional)"}</Label>
                <Input id="lock-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
                <Button onClick={save} disabled={saving || (reopening && !reason.trim())}>Save</Button>
              </div>
              {error && <Alert variant="destructive" className="sm:col-span-3"><AlertDescription>{error}</AlertDescription></Alert>}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
};

const JournalEntries = () => {
  const navigate = useNavigate();
  const { business, canKeepBooks, isLoading: businessLoading, error: businessError } = useCurrentBusiness();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: entries = [], isLoading, error, refetch } = useQuery({
    queryKey: ["journal-entries", business?.business_id],
    enabled: !!business,
    queryFn: async () => {
      const { data, error: err } = await supabase
        .from("journal_entries")
        .select("id, entry_number, entry_date, description, reference, status, source_type, source_id, reverses_entry_id, is_legacy")
        .eq("business_id", business!.business_id)
        .order("entry_date", { ascending: false })
        .order("entry_seq", { ascending: false, nullsFirst: false })
        .limit(PAGE_SIZE);
      if (err) throw err;
      return (data ?? []) as EntryRow[];
    },
  });

  const openSource = (e: EntryRow) => {
    if (e.source_type === "invoice" && e.source_id) navigate(`/invoice/${e.source_id}`);
    else if (e.source_type === "payment") navigate("/invoices");
  };

  const loadError = businessError ?? error;

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">Journal entries</h1>
            <p className="text-muted-foreground mt-1">
              Every amount in your books, as debits and credits. Invoices and payments add entries here automatically.
            </p>
          </div>
          {canKeepBooks && (
            <Button onClick={() => setIsCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" /> New journal entry
            </Button>
          )}
        </div>

        <LockDateCard />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" /> Entries</CardTitle>
            {entries.length === PAGE_SIZE && (
              <CardDescription>Showing the {PAGE_SIZE} most recent entries.</CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {loadError ? (
              <Alert variant="destructive"><AlertDescription>{ledgerErrorMessage(loadError)}</AlertDescription></Alert>
            ) : businessLoading || isLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading entries…</div>
            ) : entries.length === 0 ? (
              <div className="text-center py-10 space-y-2">
                <p className="font-medium">No journal entries yet</p>
                <p className="text-sm text-muted-foreground">
                  Sending an invoice or recording a payment creates entries automatically.
                  Use a journal entry for adjustments such as depreciation or accruals.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Number</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Memo</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((e) => (
                      <TableRow key={e.id} className={e.status === "voided" ? "text-muted-foreground" : undefined}>
                        <TableCell className="font-medium whitespace-nowrap">{e.entry_number}</TableCell>
                        <TableCell className="whitespace-nowrap">{e.entry_date}</TableCell>
                        <TableCell className="max-w-[320px] truncate">{e.description || "—"}</TableCell>
                        <TableCell>
                          {e.source_type === "invoice" || e.source_type === "payment" ? (
                            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openSource(e)}>
                              {e.source_type === "invoice" ? `Invoice ${e.reference ?? ""}` : `Payment ${e.reference ?? ""}`}
                            </Button>
                          ) : (
                            <span className="text-muted-foreground">Manual</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={e.status === "posted" ? "default" : e.status === "voided" ? "destructive" : "secondary"}>
                            {statusLabel(e)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => setSelectedId(e.id)}>View</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <CreateJournalEntryDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} onSuccess={() => refetch()} />
        <JournalEntryDetailDialog
          entryId={selectedId}
          open={!!selectedId}
          onOpenChange={(o) => !o && setSelectedId(null)}
          onChanged={() => refetch()}
        />
      </div>
    </Layout>
  );
};

export default JournalEntries;
