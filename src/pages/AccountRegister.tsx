import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import Layout from "@/components/Layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { ledgerErrorMessage } from "@/hooks/useCurrentBusiness";
import { formatMoney, toCents } from "@/lib/money";
import JournalEntryDetailDialog from "@/components/JournalEntryDetailDialog";

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const CLASS_LABEL: Record<string, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  income: "Income",
  cogs: "Cost of goods sold",
  expense: "Expense",
};

/**
 * Account register: every posted line in one account with a running balance,
 * computed from the ledger (never from a stored balance).
 */
const AccountRegister = () => {
  const { accountId } = useParams<{ accountId: string }>();
  const now = new Date();
  const [from, setFrom] = useState(isoDate(new Date(now.getFullYear(), 0, 1)));
  const [to, setTo] = useState(isoDate(now));
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);

  const { data: account, error: accountError } = useQuery({
    queryKey: ["account", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("chart_of_accounts")
        .select("id, name, account_number, account_class, normal_balance, is_system, is_active")
        .eq("id", accountId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: rows = [], isLoading, error, refetch } = useQuery({
    queryKey: ["account-register", accountId, from, to],
    enabled: !!accountId && !!from && !!to && from <= to,
    queryFn: async () => {
      const { data, error: err } = await supabase.rpc("account_register", {
        p_account_id: accountId!,
        p_from: from,
        p_to: to,
      });
      if (err) throw err;
      return data ?? [];
    },
  });

  const loadError = accountError ?? error;
  const closing = rows.length ? toCents(rows[rows.length - 1].balance) : 0;
  const activity = rows.filter((r) => !r.is_opening);

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link to="/chart-of-accounts"><ArrowLeft className="h-4 w-4 mr-1" /> Chart of accounts</Link>
        </Button>

        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">
            {account ? `${account.account_number ? `${account.account_number} · ` : ""}${account.name}` : "Account register"}
          </h1>
          {account && (
            <div className="flex flex-wrap gap-2 mt-2">
              {account.account_class && <Badge variant="secondary">{CLASS_LABEL[account.account_class]}</Badge>}
              {account.is_system && <Badge variant="outline">System account</Badge>}
              {!account.is_active && <Badge variant="destructive">Inactive</Badge>}
            </div>
          )}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Period</CardTitle>
            <CardDescription>
              Balances are calculated from posted journal entries.
              {account?.normal_balance === "credit" ? " For this account, credits increase the balance." : " For this account, debits increase the balance."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4 items-end">
            <div className="space-y-1">
              <Label htmlFor="reg-from">From</Label>
              <Input id="reg-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reg-to">To</Label>
              <Input id="reg-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="ml-auto text-right">
              <div className="text-sm text-muted-foreground">Balance on {to}</div>
              <div className="text-2xl font-semibold">{formatMoney(closing, { parentheses: true })}</div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            {from > to ? (
              <p className="text-sm text-muted-foreground">The start date must be before the end date.</p>
            ) : loadError ? (
              <Alert variant="destructive"><AlertDescription>{ledgerErrorMessage(loadError)}</AlertDescription></Alert>
            ) : isLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading…</div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Entry</TableHead>
                      <TableHead>Memo</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r, i) => (
                      <TableRow key={r.entry_id ? `${r.entry_id}-${i}` : `opening-${i}`} className={r.is_opening ? "bg-muted/40 font-medium" : undefined}>
                        <TableCell className="whitespace-nowrap">{r.entry_date}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {r.entry_id ? (
                            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setSelectedEntry(r.entry_id)}>
                              {r.entry_number}
                            </Button>
                          ) : "—"}
                          {r.status === "voided" && <Badge variant="destructive" className="ml-2">Voided</Badge>}
                        </TableCell>
                        <TableCell className="max-w-[360px] truncate">{r.line_description || r.memo || "—"}</TableCell>
                        <TableCell className="text-right">{toCents(r.debit) > 0 ? formatMoney(toCents(r.debit)) : ""}</TableCell>
                        <TableCell className="text-right">{toCents(r.credit) > 0 ? formatMoney(toCents(r.credit)) : ""}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{formatMoney(toCents(r.balance), { parentheses: true })}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {activity.length === 0 && (
                  <p className="text-center text-sm text-muted-foreground py-6">No transactions in this period.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <JournalEntryDetailDialog
          entryId={selectedEntry}
          open={!!selectedEntry}
          onOpenChange={(o) => !o && setSelectedEntry(null)}
          onChanged={() => refetch()}
        />
      </div>
    </Layout>
  );
};

export default AccountRegister;
