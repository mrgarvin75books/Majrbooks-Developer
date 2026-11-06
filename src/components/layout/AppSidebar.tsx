import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronRight, ExternalLink, PanelLeft, PanelLeftClose } from "lucide-react";
import { cn } from "@/lib/utils";
import majrLogo from "@/assets/logo-majr-books.jpg";
import type { NavGroup, NavLink, NavSection } from "./navigation";

interface AppSidebarProps {
  sections: NavSection[];
  homePath: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onNavigate: () => void;
  /** Slot under the logo (workspace label, switch link). */
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

const pathOf = (p: string) => p.split("?")[0];

function isLinkActive(link: NavLink, pathname: string) {
  return !link.external && pathOf(link.path) === pathname;
}

function isGroupActive(group: NavGroup, pathname: string) {
  return group.children ? group.children.some((c) => isLinkActive(c, pathname)) : isLinkActive(group, pathname);
}

const itemBase = "flex items-center rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";
const itemIdle = "text-white/75 hover:text-white hover:bg-white/10";
const itemActive = "bg-white/15 text-white font-medium";

export function AppSidebar({
  sections, homePath, collapsed, onToggleCollapsed, mobileOpen, onNavigate, header, footer,
}: AppSidebarProps) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // Keep the group containing the current page expanded.
  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const s of sections) for (const g of s.items) if (g.children && isGroupActive(g, pathname)) next[g.id] = true;
    setOpen((prev) => ({ ...prev, ...next }));
  }, [pathname, sections]);

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex flex-col bg-brand-navy text-white border-r border-white/10",
        "transition-[transform,width] duration-200 ease-out lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
        collapsed ? "lg:w-[56px]" : "lg:w-60",
        "w-64",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
      )}
      aria-label="Main navigation"
    >
      <div className="flex items-center justify-between gap-1 px-2 py-3 border-b border-white/10 shrink-0">
        {!collapsed && (
          <Link to={homePath} onClick={onNavigate} className="flex-1 min-w-0 px-1">
            <img src={majrLogo} alt="MAJR Books" className="h-8 w-auto max-w-[150px] object-contain rounded-sm" />
          </Link>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          className={cn("hidden lg:flex h-8 w-8 items-center justify-center rounded-md text-white/60 hover:text-white hover:bg-white/10", collapsed && "mx-auto")}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      {!collapsed && header && <div className="px-3 pt-3 shrink-0">{header}</div>}

      <nav className={cn("flex-1 overflow-y-auto overflow-x-hidden py-3", collapsed ? "px-1.5" : "px-2")}>
        {sections.map((section, i) => (
          <div key={section.id} className={cn(i > 0 && "mt-4")}>
            {section.title && !collapsed && (
              <div className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40 select-none">
                {section.title}
              </div>
            )}
            {section.title && collapsed && i > 0 && <div className="mx-1 mb-2 border-t border-white/10" />}

            <ul className="space-y-0.5">
              {section.items.map((group) => {
                const Icon = group.icon;
                const active = isGroupActive(group, pathname);

                if (!group.children || collapsed) {
                  const target = group.children ? group.children[0] : group;
                  const external = target.external;
                  const className = cn(itemBase, collapsed ? "justify-center p-2" : "gap-3 px-2 py-1.5", active ? itemActive : itemIdle);
                  return (
                    <li key={group.id}>
                      {external ? (
                        <a href={target.path} target="_blank" rel="noopener noreferrer" className={className} title={collapsed ? group.label : undefined}>
                          <Icon className="h-4 w-4 shrink-0" />
                          {!collapsed && <span className="truncate">{group.label}</span>}
                        </a>
                      ) : (
                        <Link to={target.path} onClick={onNavigate} className={className} title={collapsed ? group.label : undefined}
                          aria-current={active ? "page" : undefined}>
                          <Icon className="h-4 w-4 shrink-0" />
                          {!collapsed && <span className="truncate">{group.label}</span>}
                        </Link>
                      )}
                    </li>
                  );
                }

                const expanded = !!open[group.id];
                return (
                  <li key={group.id}>
                    <button
                      type="button"
                      onClick={() => setOpen((p) => ({ ...p, [group.id]: !p[group.id] }))}
                      aria-expanded={expanded}
                      aria-controls={`nav-${group.id}`}
                      className={cn(itemBase, "w-full justify-between px-2 py-1.5", active ? "text-white" : itemIdle)}
                    >
                      <span className="flex items-center gap-3 min-w-0">
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{group.label}</span>
                      </span>
                      <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-white/40 transition-transform", expanded && "rotate-90")} />
                    </button>
                    <div id={`nav-${group.id}`} className={cn("grid transition-all duration-200", expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                      <ul className="overflow-hidden ml-[22px] pl-3 border-l border-white/15 space-y-0.5">
                        {group.children.map((child) => {
                          const childActive = isLinkActive(child, pathname);
                          const cls = cn("flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                            childActive ? "bg-white/15 text-white font-medium" : "text-white/60 hover:text-white hover:bg-white/10");
                          return (
                            <li key={child.path} className="first:mt-0.5 last:mb-0.5">
                              {child.external ? (
                                <a href={child.path} target="_blank" rel="noopener noreferrer" className={cls}>
                                  {child.label} <ExternalLink className="h-3 w-3 opacity-60" />
                                </a>
                              ) : (
                                <Link to={child.path} onClick={onNavigate} className={cls} aria-current={childActive ? "page" : undefined}>
                                  {child.label}
                                </Link>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {!collapsed && footer && <div className="px-3 py-3 border-t border-white/10 shrink-0">{footer}</div>}
    </aside>
  );
}
