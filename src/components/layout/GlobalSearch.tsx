import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, FileText, Receipt, Search, Users } from "lucide-react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from "@/components/ui/command";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrentBusiness } from "@/hooks/useCurrentBusiness";
import { getScopeOwnerId } from "@/lib/scopeOwner";
import { formatMoney, toCents } from "@/lib/money";
import type { NavSection } from "./navigation";
import { flattenNav } from "./navigation";

/** Strips characters that have meaning in PostgREST filter strings. */
const safeTerm = (q: string) => q.replace(/[%,()*\\]/g, " ").trim().slice(0, 60);

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Ctrl/⌘+K search over pages the user can open plus records: the firm's
 * clients, the business's invoices and its accounts.
 * `trigger` lets the caller keep its own look for the search box.
 */
export function GlobalSearch({
  sections,
  trigger,
}: {
  sections: NavSection[];
  trigger?: (open: () => void) => React.ReactNode;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { business } = useCurrentBusiness();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const term = safeTerm(useDebounced(query, 250));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const pages = useMemo(() => {
    const seen = new Set<string>();
    return flattenNav(sections).filter((p) => !p.external && !seen.has(p.path) && seen.add(p.path));
  }, [sections]);

  const { data: records } = useQuery({
    queryKey: ["global-search", business?.business_id, term],
    enabled: open && !!user && term.length >= 2,
    staleTime: 30_000,
    queryFn: async () => {
      const like = `%${term}%`;
      const ownerId = await getScopeOwnerId(user!.id);
      const [cli, inv, acc] = await Promise.all([
        supabase.from("clients").select("id, client_name, email")
          .eq("user_id", ownerId).or(`client_name.ilike.${like},email.ilike.${like}`).limit(6),
        supabase.from("invoices").select("id, invoice_number, client_name, amount, status")
          .eq("user_id", user!.id).or(`invoice_number.ilike.${like},client_name.ilike.${like}`)
          .order("issue_date", { ascending: false }).limit(6),
        business
          ? supabase.from("chart_of_accounts").select("id, name, account_number")
              .eq("business_id", business.business_id).ilike("name", like).limit(6)
          : Promise.resolve({ data: [] as { id: string; name: string; account_number: string | null }[] }),
      ]);
      return { clients: cli.data ?? [], invoices: inv.data ?? [], accounts: acc.data ?? [] };
    },
  });

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <>
      {trigger ? trigger(() => setOpen(true)) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-9 w-full max-w-md items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground hover:bg-accent/50 transition-colors"
          aria-label="Search"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left truncate">Search clients, invoices, accounts and pages</span>
          <kbd className="hidden sm:inline-flex items-center rounded border bg-muted px-1.5 text-[10px] font-medium">Ctrl K</kbd>
        </button>
      )}

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type to search…" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>{term.length >= 2 ? "Nothing found." : "Type at least two letters."}</CommandEmpty>

          {!!records?.clients.length && (
            <CommandGroup heading="Clients">
              {records.clients.map((c) => (
                <CommandItem key={c.id} value={`client ${c.client_name} ${c.email ?? ""}`} onSelect={() => go(`/client/${c.id}`)}>
                  <Users className="mr-2 h-4 w-4" />
                  <span className="truncate">{c.client_name}</span>
                  {c.email && <span className="ml-auto text-xs text-muted-foreground truncate">{c.email}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {!!records?.invoices.length && (
            <CommandGroup heading="Invoices">
              {records.invoices.map((i) => (
                <CommandItem key={i.id} value={`invoice ${i.invoice_number} ${i.client_name}`} onSelect={() => go(`/invoice/${i.id}`)}>
                  <Receipt className="mr-2 h-4 w-4" />
                  <span className="truncate">{i.invoice_number} · {i.client_name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{formatMoney(toCents(i.amount))}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {!!records?.accounts.length && (
            <CommandGroup heading="Accounts">
              {records.accounts.map((a) => (
                <CommandItem key={a.id} value={`account ${a.account_number ?? ""} ${a.name}`} onSelect={() => go(`/accounts/${a.id}/register`)}>
                  <BookOpen className="mr-2 h-4 w-4" />
                  <span className="truncate">{a.account_number ? `${a.account_number} · ` : ""}{a.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {(records?.clients.length || records?.invoices.length || records?.accounts.length) ? <CommandSeparator /> : null}

          <CommandGroup heading="Pages">
            {pages.map((p) => (
              <CommandItem key={p.path} value={`${p.group} ${p.label}`} onSelect={() => go(p.path)}>
                <FileText className="mr-2 h-4 w-4" />
                <span>{p.label}</span>
                {p.group && p.group !== p.label && <span className="ml-auto text-xs text-muted-foreground">{p.group}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
