# MAJR Books — Blueprint vs. Current Software

Source: *MAJR Books – Product Blueprint* (PDF, 40 pages, 2026-11-04) compared against the code on branch `phase-0-security` (includes Phase 0 hotfixes and `main` up to `d777ac0`). Evidence comes from `docs/AUDIT-2026-11-04.md` and direct code checks.

**Legend:** ✅ exists and can be kept · 🟡 exists but must be rebuilt or extended · ❌ missing

## Bottom line

The blueprint keeps what already works: auth, invitations, Stripe, the client/contact model, payroll and tax returns. The new build is **the business data boundary, the double-entry engine and the banking workflow**. Nearly every other blueprint feature (reports, AR/AP, dashboard, tax support) depends on those three. They can't be "added" individually without them, which is why the blueprint orders the work as it does.

## 1. Foundations (blueprint "Six decisions")

| Decision | Status | What exists today |
|---|---|---|
| Two workspaces (Practice / Business) + business switcher | ❌ | One blended sidebar. "Your Books" is a bookmark list at the bottom. |
| Ledger first: one posting service; reports read only journal lines | ❌ | Three money stores that disagree: `transactions` (single-entry), `journal_entries` (only invoices/payments/manual entries), and typed-in account balances. Reports read whichever one the page picked. |
| Business is the data boundary (`business_id` on every row) | ❌ | Rows are keyed to a **user** (`user_id`). A firm's clients share one ledger. |
| Posted means locked (Draft → Posted → Voided/Reversed) | ❌ | Posted entries and lines can be edited or deleted. Invoices and transactions are hard-deleted. |
| Money is exact | 🟡 | DB columns are `NUMERIC` (good). Frontend math uses floats (`parseFloat`, float sums). |
| Audit before building | ✅ | `docs/AUDIT-2026-11-04.md` + Phase 0 fixes (`docs/PHASE-0-REPORT.md`). |

## 2. Blueprint "technical debt to confirm in Phase 0": answers

| Hypothesis | Confirmed? |
|---|---|
| Invoices, expenses, payroll store amounts with no journal entries | **Partly.** Invoices and invoice payments post entries via DB triggers. Expenses, bills, bank lines and payroll post nothing. |
| Money stored as floating point | **No** in the DB (NUMERIC). **Yes** in frontend arithmetic. |
| Role checks only in the frontend | **Mostly yes.** Route guards are redirect-only; RLS is per-user. Phase 0 added server checks to edge functions and RPCs. |
| Every query scoped by business | **No.** Scoped by user, and there's no business id. |
| Client, business entity and contact are separate tables | **No.** One `clients` row mixes client name, business name and contact name. Customers and vendors are free-text names on invoices and bills. |
| "$0.004k" chart axis bug | **Confirmed.** `DashboardCharts.tsx:240-244` divides amounts by 1,000 before charting and labels them "k". |

## 3. Feature-by-feature

### Navigation & dashboards
| Blueprint item | Status | Notes |
|---|---|---|
| Business nav (Home, Banking, Sales, Expenses, Transactions, Payroll, Reports, Taxes, Documents, Accounting, Settings) | 🟡 | Most pages exist under other names; they need regrouping. Missing: Bank rules, Imports, Credit notes, Bill payments, Recurring expenses, Mileage, Transfers, Period close, Audit log, Business settings. |
| Practice nav (Clients, Tasks, Compliance, Firm reports, Admin, Your Books) | 🟡 | Clients, tasks, deadlines, tax returns and admin exist. Firm reports are missing. |
| Context-aware "+ New" | 🟡 | Quick-add dialogs exist (invoice, expense, bill, …) but aren't context-aware. |
| Business dashboard (4 KPIs vs prior period, tasks requiring attention, owed/owing, income vs expenses, top-6 expenses, bank status, recent transactions, date range + compare, drill-down) | 🟡 | KPI and chart widgets exist, but their numbers are approximations (e.g. revenue = max of two sources). No "tasks requiring attention" rules, no compare, no drill-down, and charts of zeros instead of empty states. |
| Slimmed Practice dashboard (4 numbers + client list with books-status columns) | 🟡 | Current screen has a banner + 6 cards + pipeline chart. Books-status columns (unreviewed items, last reconciled, status) are missing. |
| Plain-word labels, ⓘ tooltips, number formats ($1,234 / $12.3k / parentheses) | ❌ | — |

### Accounting core
| Blueprint item | Status | Notes |
|---|---|---|
| Chart of accounts: 6 types with normal balance, subtypes, numbers, parent, templates by industry, system accounts, archive-not-delete | 🟡 | CRUD exists. Missing: numbers, parent, normal balance, templates and protected system accounts. Two clashing type vocabularies. Deleting an account cascades to its bank transactions. |
| Journal entries + posting service enforcing V1–V17 | 🟡 | Tables exist. No server posting service, no DB balance check (V1), no line checks (V2), no immutability (V4), no lock date (V5), no idempotency (V8). |
| Accounting periods, lock date, logged override | ❌ | — |
| Void vs reverse | ❌ | — |
| Audit log (before/after, request id, 7-year retention) | 🟡 | `audit_logs` is append-only but sparsely written, with no before/after values. |
| Opening balances (wizard → one entry vs Opening balance equity) | ❌ | — |
| Migration of existing invoices, expenses and payroll into the ledger | ❌ | Needs your decision (open question below). |

### Banking
| Blueprint item | Status | Notes |
|---|---|---|
| Bank feed provider (Plaid/MX/…) | ❌ | `BankLinkingFlow` saves **three fake accounts with fake balances** as "connected". |
| CSV/OFX/QBO import with column mapping and fingerprints | 🟡 | CSV import exists in Reconciliation (fragile parser, no dedupe). `ImportTransactionsDialog` only uploads the file. No OFX/QBO. |
| Review list (Match / Categorise / Transfer suggestions), split, exclude, undo | 🟡 | A categorise UI and AI categorisation exist. Match, transfer detection and split don't, and nothing posts to the ledger. |
| Bank rules | 🟡 | A `transaction_rules` table exists; it isn't wired to a review workflow. |
| Reconciliation (statement balance, $0.00 difference, lock, report, accountant-only undo) | 🟡 | A matching UI exists. No statement balance, no lock, no report. "Finish" in BankTransactions only shows a toast. |
| Status labels (For review / Categorized / Matched / Reconciled / Needs attention) | ❌ | — |

### Sales (AR)
| Blueprint item | Status | Notes |
|---|---|---|
| Invoices with lines, send by email, PDF, recurring, templates | ✅ / 🟡 | All exist. Needs: sequential numbering per business, income account per line, and sales tax posted to a liability (currently booked as revenue). |
| Payments (partial, multi-invoice, undeposited funds, payment applications) | 🟡 | Single-invoice payments post entries. No applications or undeposited funds; overpayment is blocked only in the UI. |
| Credit notes, customer statements, scheduled reminders | ❌ | Credit memo dialog disabled in Phase 0. An overdue-invoice workflow exists but its email action is broken. |
| Products & services | ❌ | — |
| Online invoice payments (Stripe Connect) | ❌ | Open question. |

### Expenses (AP)
| Blueprint item | Status | Notes |
|---|---|---|
| Expenses with lines, payment account, receipt | 🟡 | Single-amount rows in `transactions`; nothing posts. |
| Bills (lines, Draft→Open→Partially paid→Paid), bill payments, duplicate check | 🟡 | `bills` table, single amount, no lines or payments, no posting. (Phase 0 stopped bills being saved as invoices.) |
| Receipts with OCR suggestions (never auto-posted) | ✅ | `analyze-receipt` exists and was hardened in Phase 0. |
| Reimbursable, billable and recurring expenses; expense reports | 🟡 | `recurring_transactions` table only. |
| Vendors | ❌ | Expenses page keeps vendors in browser memory only. |
| Mileage log (rate per year from settings) | ❌ | Expenses page mileage is in-memory only. |

### Customers & vendors
| Blueprint item | Status | Notes |
|---|---|---|
| Counterparties (customer/vendor/both), contacts, addresses, tax info, 1099 flag, W-9, merge | ❌ | Free-text names only. Contractors (payroll) have their own table. |

### Reports
| Blueprint item | Status | Notes |
|---|---|---|
| P&L, Balance sheet, Cash flow, GL, Trial balance, Journal report | 🟡 | Pages exist but read the wrong sources. The balance sheet doesn't balance and the trial balance uses typed-in numbers. All need rebuilding on journal lines. |
| AR aging, AP aging, Expenses by vendor, Transaction detail by account, Reconciliation report | ❌ | — |
| Income by customer | 🟡 | `RevenueByClient` exists (reads invoices). |
| Accrual/cash basis, comparisons, filters, drill-down, saved reports, PDF/Excel/CSV export | ❌ / 🟡 | Some PDF export exists. The Reports "export" button only shows a toast. |

### Tax support
| Blueprint item | Status | Notes |
|---|---|---|
| Tax line mappings by jurisdiction and year, Schedule C report from the ledger | 🟡 | An AI Schedule C analyzer exists, but it works from uploaded statements, not the ledger. |
| 1099 tracking | 🟡 | 1099 generation and history exist for contractors (payroll). Not tied to vendors or payment method. |
| Year-end package, tax-year document folders | ❌ / 🟡 | Client documents exist; no per-year folders or request checklists. |
| Tax returns (existing) | ✅ | Kept. |

### Multi-entity, permissions, security
| Blueprint item | Status | Notes |
|---|---|---|
| Business switcher, per-business books, multi-entity groups | ❌ | `MultiEntity` page is a placeholder. |
| Memberships (person × business × role) with client toggles; permission matrix enforced server-side | ❌ | Three disconnected role systems. Team members see empty books. |
| MFA for admin/accountant, session timeout, re-auth for sensitive actions | ❌ | — |
| Field encryption of tax IDs, masking | ❌ | `profiles.ein` and `contractors.tax_id` are plaintext. |
| Stripe webhook with signature check | ❌ | No webhook; status is polled live. |
| CSV formula-injection protection, rate limits, virus scan | ❌ | — |
| Nightly integrity job (TB = 0, AR/AP tie-out) | ❌ | — |

### Testing
| Blueprint item | Status | Notes |
|---|---|---|
| Regression E2E for sign-in, invites, trial, trial→paid, cancel, roles, Stripe (blueprint Phase 0 gate) | ❌ | **Not yet done.** Only the pgTAP security tests from Phase 0. |
| Unit, property-based, golden reports ("Sample Bakery LLC"), tenant isolation, permission matrix, imports, a11y, load | ❌ | No test runner is set up yet. |

## 4. Phase alignment

The blueprint's roadmap (Phases 0–8) covers the same ground as the plan in the audit (Phases 0–9). I recommend **using the blueprint's numbering from now on**:

| Blueprint phase | Status |
|---|---|
| **0 · Audit & safety net** | Audit ✅ and security hotfixes ✅ (beyond what the blueprint asked). **Still owed:** E2E regression tests for existing flows, and the blueprint→schema mapping (this document covers the gap list). |
| **1 · Interface & navigation** (two workspaces, switcher, design tokens, dashboard shells, axis fix, permission guard) | Not started. Can run alongside Phase 2. |
| **2 · Chart of accounts & engine** (`businesses`, memberships, posting service V1–V17, periods, audit, RLS by business, migration plan) | Not started. **The critical path**, because Phases 3–5 depend on it. |
| 3 · Banking | Not started |
| 4 · Invoicing, bills, expenses | Not started |
| 5 · Reports | Not started |
| 6 · Multi-entity & accountant workflows | Not started |
| 7 · Tax support | Not started |
| 8 · Testing, security, deployment | Not started |

## 5. Decisions needed before Phase 2 (from the blueprint's open questions)

1. **Existing records:** migrate past invoices, expenses and payroll into the ledger, or start the books fresh from a chosen date with opening balances?
2. **Subscription:** billed per business or per client account when an owner has several businesses?
3. **Sales tax in v1?** Which jurisdictions? Multi-currency? (The blueprint assumes USD only.)
4. **Payroll:** keep it as a separate module that posts summary entries (blueprint default), or rebuild it?
5. **Bank feeds:** which provider (Plaid/MX/Finicity) and which countries? This affects cost and contracts, and is needed for Phase 3.
6. **Online invoice payments** (Stripe Connect) or record-only?
7. **Accountant sign-off:** who is the qualified accountant for the accounting phases?
8. Your original spec ended at "Do not…". What was the last instruction?
