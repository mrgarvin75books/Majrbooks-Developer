import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { getScopeOwnerId } from "@/lib/scopeOwner";

/**
 * Two workspaces (blueprint "Two contexts, one switcher"):
 *  - practice: the firm's work across clients (client list, invitations, tasks)
 *  - business: one company's books (dashboard, banking, sales, expenses, reports)
 *
 * Accountants, admins and firms that already have clients land in Practice;
 * everyone else lands in Business. The choice is remembered per user.
 */
export type Workspace = "practice" | "business";

interface WorkspaceContextValue {
  workspace: Workspace;
  setWorkspace: (w: Workspace) => void;
  /** Firm features are relevant to this user (admin, team member, or has clients). */
  isFirm: boolean;
  ready: boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

const storageKey = (userId: string) => `majr.workspace.${userId}`;

function readStored(userId: string): Workspace | null {
  try {
    const v = localStorage.getItem(storageKey(userId));
    return v === "practice" || v === "business" ? v : null;
  } catch {
    return null;
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, isAdmin, isStaff, isClient, loading } = useAuth();
  const [chosen, setChosen] = useState<Workspace | null>(null);

  // Does this account run a practice? (has clients or pending client invitations)
  const { data: hasClients, isFetched } = useQuery({
    queryKey: ["workspace-has-clients", user?.id],
    enabled: !!user && !isClient && !loading,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const ownerId = await getScopeOwnerId(user!.id);
      const [clients, invites] = await Promise.all([
        supabase.from("clients").select("id", { count: "exact", head: true }).eq("user_id", ownerId),
        supabase.from("client_invitations").select("id", { count: "exact", head: true }).eq("user_id", ownerId),
      ]);
      return (clients.count ?? 0) + (invites.count ?? 0) > 0;
    },
  });

  useEffect(() => {
    setChosen(user ? readStored(user.id) : null);
  }, [user]);

  const isFirm = isAdmin || isStaff || !!hasClients;
  const ready = !loading && (!user || isClient || isFetched || chosen !== null);
  const workspace: Workspace = chosen ?? (isFirm ? "practice" : "business");

  const setWorkspace = useCallback(
    (w: Workspace) => {
      setChosen(w);
      if (user) {
        try {
          localStorage.setItem(storageKey(user.id), w);
        } catch {
          /* private mode: the choice just won't persist */
        }
      }
    },
    [user],
  );

  const value = useMemo(() => ({ workspace, setWorkspace, isFirm, ready }), [workspace, setWorkspace, isFirm, ready]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
