import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Bot,
  Briefcase,
  Building2,
  CalendarClock,
  CreditCard,
  FileSpreadsheet,
  Landmark,
  LayoutDashboard,
  MessageCircle,
  Receipt,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
  FolderOpen,
} from "lucide-react";

/**
 * Sidebar navigation for the two workspaces (blueprint "Navigation").
 * Every path here must exist in App.tsx and be reachable for the roles
 * that can see it — no link may lead to a redirect.
 */
export interface NavLink {
  label: string;
  path: string;
  external?: boolean;
  /** Only shown when this returns true. */
  show?: (ctx: NavContext) => boolean;
}

export interface NavGroup extends NavLink {
  id: string;
  icon: LucideIcon;
  /** Subscription module key (lib/subscriptionTiers) that gates this group. */
  module?: string;
  children?: NavLink[];
}

export interface NavSection {
  id: string;
  title?: string;
  items: NavGroup[];
}

export interface NavContext {
  isAdmin: boolean;
  isOwner: boolean;
  isStaff: boolean;
  canKeepBooks: boolean;
}

const ownerOrAdmin = (c: NavContext) => c.isAdmin || c.isOwner;
const adminOnly = (c: NavContext) => c.isAdmin;
const bookkeeper = (c: NavContext) => c.canKeepBooks || c.isAdmin;

export const businessNav: NavSection[] = [
  {
    id: "home",
    items: [{ id: "home", label: "Home", path: "/home", icon: LayoutDashboard }],
  },
  {
    id: "money",
    title: "Money in and out",
    items: [
      {
        id: "banking", label: "Banking", path: "/bank-transactions", icon: Landmark, module: "transactions",
        children: [
          { label: "Bank transactions", path: "/bank-transactions" },
          { label: "Reconcile", path: "/bank-reconciliation" },
        ],
      },
      {
        id: "sales", label: "Sales", path: "/invoices", icon: Receipt, module: "invoices",
        children: [
          { label: "Invoices", path: "/invoices" },
          { label: "New invoice", path: "/invoice/new" },
          { label: "Templates and recurring", path: "/invoice-templates" },
          { label: "Income by customer", path: "/revenue-by-client" },
          { label: "Sales tax", path: "/sales-tax-summary" },
        ],
      },
      { id: "expenses", label: "Expenses and bills", path: "/expenses", icon: CreditCard, module: "expenses" },
      {
        id: "transactions", label: "Transactions", path: "/transactions", icon: ArrowLeftRight, module: "transactions",
        children: [
          { label: "All transactions", path: "/transactions" },
          { label: "Journal entries", path: "/journal-entries" },
        ],
      },
    ],
  },
  {
    id: "people-tax",
    title: "Payroll and tax",
    items: [
      {
        id: "payroll", label: "Payroll", path: "/payroll-dashboard", icon: UsersRound, module: "payroll",
        children: [
          { label: "Overview", path: "/payroll-dashboard" },
          { label: "Pay runs", path: "/payroll-runs" },
          { label: "Payroll setup", path: "/payroll-setup" },
          { label: "Timesheets", path: "/timesheets" },
          { label: "1099s", path: "/1099-history" },
        ],
      },
      {
        id: "taxes", label: "Taxes", path: "/tax-returns", icon: FileSpreadsheet, module: "tax-returns",
        children: [
          { label: "Tax returns", path: "/tax-returns" },
          { label: "Schedule C & P&L from statements", path: "/schedule-c" },
          { label: "Tax Majr AI", path: "https://taxmajr.ai/", external: true },
        ],
      },
    ],
  },
  {
    id: "insights",
    title: "Reports",
    items: [
      {
        id: "reports", label: "Reports", path: "/reports", icon: BarChart3, module: "reports",
        children: [
          { label: "All reports", path: "/reports" },
          { label: "Profit and loss", path: "/profit-and-loss" },
          { label: "Balance sheet", path: "/balance-sheet" },
          { label: "Cash flow", path: "/cash-flow" },
          { label: "Trial balance", path: "/trial-balance" },
          { label: "General ledger", path: "/general-ledger" },
          { label: "Journal report", path: "/journal-entry-report" },
        ],
      },
    ],
  },
  {
    id: "books",
    title: "Books",
    items: [
      {
        id: "accounting", label: "Accounting", path: "/chart-of-accounts", icon: BookOpen, show: bookkeeper,
        children: [
          { label: "Chart of accounts", path: "/chart-of-accounts" },
          { label: "Journal entries and closing", path: "/journal-entries" },
        ],
      },
      { id: "settings", label: "Business settings", path: "/settings", icon: Settings },
    ],
  },
];

export const practiceNav: NavSection[] = [
  {
    id: "home",
    items: [{ id: "practice-home", label: "Practice home", path: "/dashboard", icon: LayoutDashboard }],
  },
  {
    id: "clients",
    title: "Clients",
    items: [
      {
        id: "clients", label: "Clients", path: "/dashboard", icon: Users,
        children: [
          { label: "Client list", path: "/dashboard" },
          { label: "Invitations", path: "/client-invitations" },
          { label: "Multi-entity groups", path: "/multi-entity" },
          { label: "Bulk upload", path: "/bulk-client-upload", show: adminOnly },
        ],
      },
    ],
  },
  {
    id: "work",
    title: "Work",
    items: [
      {
        id: "tasks", label: "Tasks", path: "/tasks", icon: Briefcase,
        children: [
          { label: "Tasks", path: "/tasks" },
          { label: "Projects", path: "/projects" },
          { label: "Workflow automation", path: "/workflow-automation" },
        ],
      },
      {
        id: "compliance", label: "Compliance", path: "/tax-returns", icon: CalendarClock, module: "tax-returns",
        children: [
          { label: "Tax returns", path: "/tax-returns" },
          { label: "Schedule C & P&L from statements", path: "/schedule-c" },
          { label: "Deadlines", path: "/deadlines" },
        ],
      },
      {
        id: "time", label: "Time", path: "/timesheets", icon: FolderOpen, module: "payroll",
        children: [
          { label: "Timesheets", path: "/timesheets" },
          { label: "Time dashboard", path: "/time-tracking-dashboard" },
          { label: "Time analytics", path: "/time-tracking-analytics" },
          { label: "PTO", path: "/pto-management" },
        ],
      },
    ],
  },
  {
    id: "admin",
    title: "Admin",
    items: [
      { id: "team", label: "Team", path: "/team", icon: UsersRound, show: ownerOrAdmin },
      { id: "permissions", label: "User permissions", path: "/user-permissions", icon: ShieldCheck, show: ownerOrAdmin },
      {
        id: "billing", label: "Subscription and billing", path: "/billing/firm-subscriptions", icon: Building2, show: ownerOrAdmin,
        children: [
          { label: "My subscription", path: "/billing/firm-subscriptions" },
          { label: "Billing details", path: "/billing/billing-details" },
          { label: "Client subscriptions", path: "/billing/client-subscriptions", show: adminOnly },
          { label: "Product recommendations", path: "/billing/product-recommendations", show: adminOnly },
          { label: "Revenue share", path: "/billing/revenue-share", show: adminOnly },
        ],
      },
      { id: "admin-console", label: "Admin console", path: "/admin", icon: ShieldCheck, show: adminOnly },
      { id: "practice-settings", label: "Settings", path: "/settings", icon: Settings },
    ],
  },
];

export const clientNav: NavSection[] = [
  {
    id: "portal",
    items: [
      { id: "portal", label: "My portal", path: "/client-portal", icon: LayoutDashboard },
      { id: "my-invoices", label: "My invoices", path: "/client-invoices", icon: Receipt },
      { id: "documents", label: "Documents", path: "/client-documents", icon: FolderOpen },
      { id: "assistant", label: "AI assistant", path: "/client-ai", icon: Bot },
      { id: "support", label: "Support", path: "/client-support", icon: MessageCircle },
      { id: "client-settings", label: "Settings", path: "/client-settings", icon: Settings },
    ],
  },
];

/** Applies role and plan gating; drops groups whose every link is hidden. */
export function filterNav(
  sections: NavSection[],
  ctx: NavContext,
  moduleAllowed: (module: string) => boolean,
): NavSection[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items
        .filter((g) => (!g.show || g.show(ctx)) && (!g.module || moduleAllowed(g.module)))
        .map((g) => (g.children ? { ...g, children: g.children.filter((c) => !c.show || c.show(ctx)) } : g))
        .filter((g) => !g.children || g.children.length > 0),
    }))
    .filter((s) => s.items.length > 0);
}

/** Flat list of every visible link, for global search. */
export function flattenNav(sections: NavSection[]): { label: string; path: string; group: string; external?: boolean }[] {
  const out: { label: string; path: string; group: string; external?: boolean }[] = [];
  for (const s of sections) {
    for (const g of s.items) {
      if (g.children) for (const c of g.children) out.push({ label: c.label, path: c.path, group: g.label, external: c.external });
      else out.push({ label: g.label, path: g.path, group: s.title ?? "", external: g.external });
    }
  }
  return out;
}
