import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface CurrentBusiness {
  business_id: string;
  name: string;
  role: "owner" | "admin" | "accountant" | "staff" | "client";
  lock_date: string | null;
  accounting_method: "accrual" | "cash";
}

/**
 * The business (set of books) the signed-in user is working in.
 *
 * Until the Phase 1 business switcher exists this is the user's own default
 * business ("Your Books"), or their firm owner's for team members.
 */
export function useCurrentBusiness() {
  const { user, isClient } = useAuth();
  const query = useQuery({
    queryKey: ["current-business", user?.id],
    enabled: !!user && !isClient,
    staleTime: 60_000,
    queryFn: async (): Promise<CurrentBusiness | null> => {
      const { data, error } = await supabase.rpc("current_business");
      if (error) throw error;
      return (data?.[0] as CurrentBusiness | undefined) ?? null;
    },
  });
  const business = query.data ?? null;
  return {
    ...query,
    business,
    canKeepBooks: !!business && ["owner", "admin", "accountant"].includes(business.role),
  };
}

/**
 * The posting engine raises errors as "CODE: human message". Show the
 * human part to users; keep the code for logic.
 */
export function ledgerErrorMessage(error: unknown): string {
  const raw = (error as { message?: string })?.message ?? String(error ?? "Something went wrong");
  const match = /^([A-Z_]+):\s*(.+)$/s.exec(raw);
  return match ? match[2] : raw;
}

export function ledgerErrorCode(error: unknown): string | null {
  const raw = (error as { message?: string })?.message ?? "";
  return /^([A-Z_]+):/.exec(raw)?.[1] ?? null;
}
