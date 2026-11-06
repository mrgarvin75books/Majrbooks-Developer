import { ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Clock, HelpCircle, LogOut, Menu, Settings, Sparkles, UserCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useCurrentBusiness } from "@/hooks/useCurrentBusiness";
import { hasAccessToModule } from "@/lib/subscriptionTiers";
import TrialExpiryModal from "@/components/TrialExpiryModal";
import UpgradeModal from "@/components/UpgradeModal";
import NotificationBadge from "@/components/NotificationBadge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { BusinessSwitcher } from "@/components/layout/BusinessSwitcher";
import { GlobalSearch } from "@/components/layout/GlobalSearch";
import { NewMenu } from "@/components/layout/NewMenu";
import { businessNav, clientNav, filterNav, practiceNav } from "@/components/layout/navigation";

interface LayoutProps {
  children: ReactNode;
}

const COLLAPSE_KEY = "sidebarCollapsed";

const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "true";
  } catch {
    return false;
  }
};

/**
 * App shell: navy sidebar for the current workspace (Practice or Business),
 * top bar with the business switcher, search, "+ New", notifications, help
 * and the user menu.
 */
const Layout = ({ children }: LayoutProps) => {
  const {
    signOut, user, subscriptionTier, subscribed, isTrial, trialDaysRemaining, isAdmin, isClient, isStaff, isOwner, loading,
  } = useAuth();
  const { workspace, setWorkspace } = useWorkspace();
  const { canKeepBooks } = useCurrentBusiness();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // Paywall: account owners without an active plan or trial go to plan selection.
  // Team members and clients are covered by their firm's subscription.
  useEffect(() => {
    if (loading || !user) return;
    if (subscribed || isTrial || subscriptionTier !== null || isAdmin || isStaff || isClient) return;
    const timer = setTimeout(() => navigate("/auth"), 3000);
    return () => clearTimeout(timer);
  }, [user, subscribed, subscriptionTier, isTrial, isAdmin, isStaff, isClient, loading, navigate]);

  const { data: profile } = useQuery({
    queryKey: ["profile-header", user?.id],
    enabled: !!user,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("full_name, avatar_url").eq("id", user!.id).maybeSingle();
      return data;
    },
  });

  const sections = useMemo(() => {
    if (isClient) return clientNav;
    const ctx = { isAdmin, isOwner, isStaff, canKeepBooks };
    // Team members work under their owner's plan, so plan-tier gating doesn't apply to them.
    const moduleAllowed = (m: string) => isAdmin || isStaff || hasAccessToModule(subscriptionTier, m);
    return filterNav(workspace === "practice" ? practiceNav : businessNav, ctx, moduleAllowed);
  }, [isClient, isAdmin, isOwner, isStaff, canKeepBooks, workspace, subscriptionTier]);

  const homePath = isClient ? "/client-portal" : workspace === "practice" ? "/dashboard" : "/home";

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, String(!prev));
      } catch {
        /* ignore */
      }
      return !prev;
    });
  };

  const switchTo = (w: "practice" | "business") => {
    setWorkspace(w);
    setMobileOpen(false);
    navigate(w === "practice" ? "/dashboard" : "/home");
  };

  const displayName = profile?.full_name || user?.email?.split("@")[0] || "Account";
  const roleLabel = isAdmin ? "Admin" : isClient ? "Client" : isStaff ? "Team member" : "Owner";
  const showTrialUi = !isAdmin && !isStaff && !isClient && isTrial && trialDaysRemaining !== null;

  return (
    <div className="min-h-screen bg-background flex">
      <AppSidebar
        sections={sections}
        homePath={homePath}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileOpen}
        onNavigate={() => setMobileOpen(false)}
        header={
          !isClient ? (
            <div className="text-[11px] uppercase tracking-wider text-white/40 font-semibold px-1">
              {workspace === "practice" ? "Practice" : "Business"}
            </div>
          ) : null
        }
        footer={
          !isClient ? (
            <button
              type="button"
              onClick={() => switchTo(workspace === "practice" ? "business" : "practice")}
              className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/10"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
              {workspace === "practice" ? "Open your books" : "Go to Practice"}
            </button>
          ) : null
        }
      />

      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}

      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden shrink-0"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </Button>

            {!isClient && (
              <div className="hidden sm:block shrink-0">
                <BusinessSwitcher />
              </div>
            )}

            <div className="flex-1 min-w-0 flex justify-center px-1">
              {!isClient && <GlobalSearch sections={sections} />}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {!isClient && <NewMenu compact={false} />}
              <NotificationBadge />
              <Button variant="ghost" size="icon" asChild aria-label="Help and resources" className="hidden sm:inline-flex">
                <Link to={isClient ? "/client-support" : "/resources"}><HelpCircle className="h-5 w-5" /></Link>
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-9 gap-2 px-2" aria-label="Account menu">
                    {profile?.avatar_url ? (
                      <img src={profile.avatar_url} alt="" className="h-7 w-7 rounded-full object-cover border" />
                    ) : (
                      <span className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center">
                        <UserCircle className="h-5 w-5 text-primary" />
                      </span>
                    )}
                    <span className="hidden md:block max-w-[140px] truncate text-sm font-medium">{displayName}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <div className="px-3 py-2">
                    <div className="text-sm font-medium truncate">{displayName}</div>
                    <div className="text-xs text-muted-foreground truncate">{user?.email}</div>
                    <span className="mt-1 inline-block rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                      {roleLabel}
                    </span>
                  </div>
                  <DropdownMenuSeparator />
                  {!isClient && (
                    <div className="sm:hidden">
                      <DropdownMenuItem onSelect={() => switchTo(workspace === "practice" ? "business" : "practice")} className="gap-2">
                        <ArrowLeftRight className="h-4 w-4" />
                        {workspace === "practice" ? "Open your books" : "Go to Practice"}
                      </DropdownMenuItem>
                    </div>
                  )}
                  {(isOwner || isAdmin) && (
                    <DropdownMenuItem asChild className="gap-2 cursor-pointer">
                      <Link to="/billing/firm-subscriptions"><Sparkles className="h-4 w-4" /> My subscription</Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem asChild className="gap-2 cursor-pointer">
                    <Link to={isClient ? "/client-settings" : "/settings"}><Settings className="h-4 w-4" /> Settings</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="gap-2 cursor-pointer sm:hidden">
                    <Link to={isClient ? "/client-support" : "/resources"}><HelpCircle className="h-4 w-4" /> Help</Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={signOut} className="gap-2 text-destructive focus:text-destructive cursor-pointer">
                    <LogOut className="h-4 w-4" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {!isClient && (
            <div className="sm:hidden px-3 pb-2">
              <BusinessSwitcher />
            </div>
          )}
        </header>

        {showTrialUi && (
          <div className="border-b bg-primary/5 px-4 sm:px-6 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-primary" />
                <span><strong>{trialDaysRemaining} days</strong> left in your free trial</span>
              </div>
              <Button size="sm" className="gap-1" onClick={() => setUpgradeOpen(true)}>
                <Sparkles className="h-3 w-3" /> Choose a plan
              </Button>
            </div>
          </div>
        )}

        <UpgradeModal open={upgradeOpen} onOpenChange={setUpgradeOpen} />

        <main className="flex-1 min-w-0 p-4 sm:p-6 bg-background">{children}</main>
      </div>

      {showTrialUi && trialDaysRemaining! <= 3 && (
        <TrialExpiryModal
          daysRemaining={trialDaysRemaining!}
          isTrialExpired={trialDaysRemaining! <= 0}
          userEmail={user?.email}
        />
      )}
    </div>
  );
};

export default Layout;
