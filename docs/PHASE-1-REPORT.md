# Blueprint Phase 1 — Interface and navigation

Branch: `phase-0-security` · 2026-11-06 · Not committed or deployed.

## What changed

### Two workspaces and a switcher
- **Practice** (firm work across clients) and **Business** (one company's books) each have their own sidebar.
- **Landing workspace:** admins, invited team members and accounts that already have clients or client invitations land in Practice. Everyone else lands in Business.
- **Remembered choice:** the workspace you pick is remembered for each user on that device.
- **Business switcher** in the top bar: lists *Your books* and *Practice*. Client businesses join the list when they get their own books (blueprint Phase 6).
- **Sidebar footer** has a one-click "Open your books" / "Go to Practice".

### New shell (`src/components/Layout.tsx` + `src/components/layout/`)
- **Navigation config:** `navigation.ts` holds both menus and the client portal menu. Every link points to a route that exists and is reachable for the roles that see it. Role and plan gating match the route guards.
- **Links removed** because they led to redirects or marketing pages:
  - staff "AI Support" (a client-only page)
  - client "Training" (a staff-only page)
  - "Receipt capture" (`/expense-tracking` is a marketing page)
  - the duplicate "Your Books" drag-and-drop list
  - "Bulk upload" for non-admins
- **Top bar:** business switcher · global search · context-aware **+ New** · notifications · help · account menu.
- **Global search (Ctrl/⌘ + K):** searches menu pages plus records.
  - In a business: invoices (number or customer) and accounts.
  - In Practice: clients (name or email).
- **+ New:**
  - Business: Invoice, Expense, Bill, Journal entry (bookkeepers only).
  - Practice: Client, Client invitation, Task.
- **Kept unchanged:**
  - the paywall redirect (now also exempts clients, who are covered by their firm)
  - the trial banner and trial-expiry modal
  - the upgrade modal and the profile menu
- **Responsive:** the sidebar slides in on phones; the switcher moves under the top bar on small screens.

### Design tokens
- **New tokens:** `--brand-navy`, `--brand-navy-soft`, `--brand-green`, `--chart-income`, `--chart-expense` and `--warning` in `src/index.css`, exposed in Tailwind as `brand.*` and `warning`.
- **Sidebar color:** the sidebar now uses the navy token instead of an inline color.
- **Green:** one green (`--primary`) remains the colour for primary actions.

### Business dashboard (`/home`, new)
- **Layout** follows the blueprint wireframe:
  1. **Header:** date range (This month, Last month, This quarter, Year to date, Last year, Custom) and **Compare to** (Previous period, Same period last year, None). The range applies to every tile.
  2. **Row 1:** Income, Expenses, Net profit, and Cash and bank, with % change versus the comparison period.
  3. **Row 2:** *Needs your attention* (bank lines to review, accounts not reconciled in 45 days, overdue invoices, bills due within 7 days, draft journal entries), each with a count and a link. Beside it, *Owed and owing*: money owed to you (with the overdue part) and money you owe (with what's due within 7 days).
  4. **Row 3:** Income and expenses by month (12 months) and the top 6 expense accounts.
  5. **Row 4:** Bank accounts (balance in the books, last reconciled, needs-reconciling badge) and the 10 most recent entries, which open the entry detail.
- **Data source:** money figures come from the **ledger only** (`business_dashboard()` database function). Work counts come from the invoice, bill and bank tables.
- **New business:** shows a 3-step *Get your books started* checklist instead of empty charts. It never shows a chart of zeros.
- **Honesty notice:** if older screens hold transactions or open bills that aren't in the ledger yet, a note says so, so the totals aren't mistaken for complete.
- **Label rules:** plain words first, with ⓘ explanations for accounting terms. Amounts follow the blueprint format ($1,234 under $10k, $12.3k above), with full precision on hover.
- **Known limitation:** tiles link to the existing report pages, which don't take a date range yet. Report filters by date arrive with the report rebuild in Phase 5.

### Practice dashboard (`/dashboard`)
- **Top of page:** the gradient banner, six overlapping cards, revenue chart and pipeline chart are replaced by one row of four linked numbers: active clients, pending signups (with accounts created), returns to review, and returns in progress.
- **Not shown yet:** the blueprint's "Behind on reconciliation" tile needs per-client books (Phase 6), so it isn't shown rather than faked.
- **Client list:** the client list and its tabs are unchanged.
- **Button cleanups:** "Feedback?" (did nothing) is removed, "Upgrade Now" becomes "See plans", and Bulk upload is shown to admins only.
- **Redirect:** in the Business workspace, `/dashboard` redirects to `/home`.

### "$0.004k" axis bug, fixed
- `DashboardCharts` divided amounts by 1,000 before charting.
- CashflowSnapshot, MonthlyKPIs and ProfitLossSummary labelled every tick in thousands, so small values showed as "$0k".
- All now use `formatMoneyCompact` (tested in `money.test.ts`).

### Server-side permission set
- **`my_permissions(business)`** returns the blueprint permission matrix as named permissions:
  - owner and admin get everything
  - accountants get everything except managing users (lead accountants excepted) and the subscription
  - staff can view only
  - clients get the blueprint defaults, adjustable per client through `client_toggles`
- **Frontend:** `usePermissionSet().can("journal.create")`. The frontend uses this only to hide buttons; the database functions enforce the same rules.

## Files
- **New:**
  - `src/components/layout/{navigation.ts, AppSidebar.tsx, BusinessSwitcher.tsx, GlobalSearch.tsx, NewMenu.tsx}`
  - `src/contexts/WorkspaceContext.tsx`
  - `src/pages/BusinessHome.tsx`
  - `src/hooks/usePermissionSet.ts`
  - `src/lib/dateRanges.ts` (+ tests)
  - `supabase/migrations/20261106100000_phase1_dashboard_permissions.sql`
- **Changed:**
  - `src/components/Layout.tsx` (rewritten, same `<Layout>` API, so no page changes were needed)
  - `src/App.tsx`
  - `src/pages/Dashboard.tsx`
  - `src/index.css`, `tailwind.config.ts`
  - four chart components
  - `src/integrations/supabase/types.ts`

## Verification
| Check | Result |
|---|---|
| Unit + property tests (`npm test`) | ✅ 46 passed (15 new date-range tests) |
| Typecheck / lint / build | ✅ No new errors (the same 5 errors as before remain) / ✅ 0 errors / ✅ build passes |
| Browser: new routes load; signed-out users are redirected to sign-in; no console errors | ✅ |
| Signed-in look and feel (sidebars, switcher, search, + New, dashboard) | ⏳ **Not seen.** No test account here |
| `business_dashboard` / `my_permissions` against a database | ⏳ **Not run.** Needs the staging database; until the migrations are applied, Home shows a "database update not installed" message |
