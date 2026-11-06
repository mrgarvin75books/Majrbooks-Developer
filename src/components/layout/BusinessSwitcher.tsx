import { useNavigate } from "react-router-dom";
import { Briefcase, Building2, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useCurrentBusiness } from "@/hooks/useCurrentBusiness";

/**
 * Top-bar switcher between the Practice workspace and a business's books.
 * Lists the businesses the user can open; client businesses join this list
 * when they get their own books (blueprint Phase 6).
 */
export function BusinessSwitcher() {
  const navigate = useNavigate();
  const { workspace, setWorkspace, isFirm } = useWorkspace();
  const { business } = useCurrentBusiness();
  const businessName = business?.name ?? "Your books";

  const open = (w: "practice" | "business") => {
    setWorkspace(w);
    navigate(w === "practice" ? "/dashboard" : "/home");
  };

  const label = workspace === "practice" ? "Practice" : businessName;
  const Icon = workspace === "practice" ? Briefcase : Building2;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-9 max-w-[220px] gap-2 px-3" aria-label={`Current workspace: ${label}. Switch workspace`}>
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Businesses</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => open("business")} className="gap-2 py-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="truncate font-medium">{businessName}</div>
            <div className="text-xs text-muted-foreground">
              {business?.role === "owner" ? "Your books" : business ? `Books you keep as ${business.role}` : "Your books"}
            </div>
          </div>
          {workspace === "business" && <Check className="h-4 w-4 text-primary" />}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Firm</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => open("practice")} className="gap-2 py-2">
          <Briefcase className="h-4 w-4 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">Practice</div>
            <div className="text-xs text-muted-foreground">
              {isFirm ? "Clients, invitations, tasks and compliance" : "Work with clients as an accountant or bookkeeper"}
            </div>
          </div>
          {workspace === "practice" && <Check className="h-4 w-4 text-primary" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
