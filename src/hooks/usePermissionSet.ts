import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentBusiness } from "@/hooks/useCurrentBusiness";

/** Named permissions from the blueprint permission matrix. */
export type Permission =
  | "dashboard.view" | "reports.view" | "reports.export"
  | "bank.categorize" | "bank.connect" | "bank.reconcile" | "bank.reconcile.undo"
  | "sales.create" | "expenses.create" | "transactions.edit_posted"
  | "journal.create" | "accounts.manage" | "periods.lock"
  | "contacts.manage" | "tax.manage" | "documents.manage" | "audit.view"
  | "business.users.manage" | "subscription.manage";

/**
 * The caller's permissions in the current business, resolved on the server
 * (my_permissions). Use it to hide actions; the server enforces them anyway.
 */
export function usePermissionSet() {
  const { business } = useCurrentBusiness();
  const query = useQuery({
    queryKey: ["my-permissions", business?.business_id],
    enabled: !!business,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_permissions", { p_business_id: business!.business_id });
      if (error) throw error;
      return new Set((data ?? []) as Permission[]);
    },
  });
  const set = query.data ?? new Set<Permission>();
  return { ...query, can: (p: Permission) => set.has(p) };
}
