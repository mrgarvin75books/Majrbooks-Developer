import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, CreditCard, FileText, ListTodo, Plus, Receipt, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useCurrentBusiness } from "@/hooks/useCurrentBusiness";
import { QuickAddExpenseDialog } from "@/components/dialogs/QuickAddExpenseDialog";
import { QuickAddBillDialog } from "@/components/dialogs/QuickAddBillDialog";
import { QuickAddClientDialog } from "@/components/dialogs/QuickAddClientDialog";
import CreateJournalEntryDialog from "@/components/CreateJournalEntryDialog";

type DialogKey = "expense" | "bill" | "journal" | "client" | null;

/**
 * Context-aware "+ New" (blueprint): in a business it creates money
 * documents; in Practice it creates firm records.
 */
export function NewMenu({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const { workspace } = useWorkspace();
  const { canKeepBooks } = useCurrentBusiness();
  const [dialog, setDialog] = useState<DialogKey>(null);
  const close = (o: boolean) => !o && setDialog(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="h-9 gap-1.5" aria-label="Create new">
            <Plus className="h-4 w-4" />
            {!compact && <span>New</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {workspace === "business" ? (
            <>
              <DropdownMenuItem onSelect={() => navigate("/invoice/new")} className="gap-2">
                <Receipt className="h-4 w-4" /> Invoice
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("expense")} className="gap-2">
                <CreditCard className="h-4 w-4" /> Expense
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("bill")} className="gap-2">
                <FileText className="h-4 w-4" /> Bill
              </DropdownMenuItem>
              {canKeepBooks && (
                <DropdownMenuItem onSelect={() => setDialog("journal")} className="gap-2">
                  <BookOpen className="h-4 w-4" /> Journal entry
                </DropdownMenuItem>
              )}
            </>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => setDialog("client")} className="gap-2">
                <Users className="h-4 w-4" /> Client
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate("/client-invitations")} className="gap-2">
                <UserPlus className="h-4 w-4" /> Client invitation
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate("/tasks")} className="gap-2">
                <ListTodo className="h-4 w-4" /> Task
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <QuickAddExpenseDialog open={dialog === "expense"} onOpenChange={close} />
      <QuickAddBillDialog open={dialog === "bill"} onOpenChange={close} />
      <QuickAddClientDialog open={dialog === "client"} onOpenChange={close} />
      <CreateJournalEntryDialog open={dialog === "journal"} onOpenChange={close} onSuccess={() => setDialog(null)} />
    </>
  );
}
