import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Info } from "lucide-react";

interface QuickAddCreditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Credit memos are temporarily unavailable.
 *
 * The previous implementation saved a credit as a negative invoice. The
 * database rejects negative invoice amounts, so it always failed, and even if
 * it had succeeded it would have posted a negative Accounts Receivable /
 * Revenue journal entry. Credit memos will return with the Sales module
 * rebuild (Phase 5), posted as a proper Dr Revenue / Cr Accounts Receivable
 * entry and applied against open invoices.
 */
export const QuickAddCreditDialog = ({ open, onOpenChange }: QuickAddCreditDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Credit Memos</DialogTitle>
          <DialogDescription>Coming with the upcoming Sales update.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-3 rounded-md border bg-muted/40 p-4 text-sm">
          <Info className="h-5 w-5 shrink-0 text-primary" />
          <p>
            Credit memos are being rebuilt so they post correctly to your books and can be applied to
            open invoices. Until then, to credit a customer, edit the original invoice or record an
            adjusting journal entry.
          </p>
        </div>
        <div className="flex justify-end pt-2">
          <Button onClick={() => onOpenChange(false)}>Got it</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
