# Blueprint Phase 2 — Part A: Business boundary + posting engine

Branch: `phase-0-security` · 2026-11-05 · Not committed and not deployed yet.

## Decisions taken (defaults; tell me to change any)

| Open question | Default used | Effect |
|---|---|---|
| Migrate existing records into the ledger? | **No, not yet.** Existing journal entries are kept untouched and flagged `is_legacy`. | History migration becomes a separate, reversible step once you decide (part B). |
| Sales tax in v1 | **Yes, to a liability.** Invoice tax now credits *Sales Tax Payable* instead of revenue. | Applies to invoices posted after deploy. |
| Payroll | Stays a separate module. | Payroll still posts nothing; summary entries come in part B. |
| Customer payments land in | *Undeposited Funds* (blueprint rule) | Moves to the bank account when deposits are matched in Phase 3. |

## What was built

### Database: `20261105100000_phase2_businesses.sql`
- **`businesses` and `business_members`.**
  - Every account owner gets a default business ("Your Books").
  - Active team members become members of their owner's business: admin → admin, accountant → accountant, employee → staff. A trigger keeps this in sync with `team_members`.
- **`business_id` on the ledger tables**, backfilled: `chart_of_accounts`, `journal_entries`, `journal_entry_lines`, `audit_logs`.
- **RLS on those tables is now by membership, not user id:**
  - Any member can read.
  - Owners, admins and accountants can manage accounts.
  - **Journal tables have no write policies at all.** Every write goes through the posting functions.
  - Side effect: invited accountants can now read and post to the owner's books at the database level. The existing screens still filter by user id, so they see the owner's entries only where a screen queries by business (Journal Entries, Account Register).
- **`current_business()`** tells the frontend which books the user is in, until the Phase 1 switcher exists.

### Database: `20261105110000_phase2_ledger_engine.sql`
- **Chart of accounts:**
  - Six account classes with normal balances.
  - Existing free-text types (both vocabularies) are mapped automatically.
  - Account numbers, unique per business; parent accounts.
  - **9 system accounts** per business: AR, AP, Undeposited Funds, Sales Tax Payable, Opening Balance Equity, Retained Earnings, Sales, Uncategorized Income and Expense. Existing same-named accounts are adopted rather than duplicated.
  - Accounts with transactions can't be deleted, only made inactive.
  - Deleting an account no longer deletes its bank transactions.
- **Posting service `_post_entry`:** the only code that writes journal lines. It validates everything before writing and runs in one transaction.
- **Rules enforced** (blueprint V-numbers):
  - V1 debits = credits to the cent: in the service and in a deferred database check.
  - V2 ≥ 2 lines, each a debit or a credit, never both.
  - V3 same-business accounts.
  - V4 posted entries and their lines are immutable (database trigger).
  - V5 lock date.
  - V6 inactive accounts.
  - V7 each source document posts once.
  - V8 idempotency keys.
  - V10 payments can't exceed the open balance.
  - V13 integrity check function.
  - V15 cents precision.
  - V16 system accounts protected.
- **Void vs reverse:**
  - Void posts a same-date reversing entry and marks the original *voided*. It needs a reason.
  - Reverse posts the mirror entry on a new date.
  - Both keep the original. The ledger includes posted and voided entries, so past periods never change.
- **Lock date:** `set_lock_date()`. Reopening a closed period requires a reason. Every change is written to the audit log.
- **Invoices and payments now post through the engine:**
  - Editing an invoice's amount, tax or date voids and re-posts its entry.
  - Cancelling or deleting an invoice or payment voids its entry instead of leaving it orphaned.
  - Cancelling an invoice that has payments is refused.
- **Read functions:** `account_balances`, `account_register` (running balance), `ledger_integrity`, and a `ledger_lines` view that reports will read in Phase 5.

### Frontend
- **New journal entry** uses `post_journal_entry`:
  - One atomic call with exact cents validation and plain-language errors.
  - An idempotency key per dialog, so a double-click can't post twice.
  - Save as draft, and a lock-date warning.
- **Entry detail:**
  - Post or delete drafts.
  - Void (with reason) or reverse posted manual entries.
  - Invoice and payment entries point to their source document instead.
- **Journal Entries page:** business-scoped list with Draft / Posted / Voided / Reversal status, invoice links, and a *Closed periods* card to change the lock date.
- **Account Register page** (`/accounts/:id/register`, opened from Chart of Accounts → View register): opening balance plus a running balance from the ledger.
- **`src/lib/money.ts`:** integer-cents parsing, summing and formatting, plus a compact formatter that fixes the "$0.004k" bug. The charts switch to it in Phase 1.
- Journal Entry Report now includes voided entries, so each void and its reversal net to zero. The General Ledger no longer counts drafts.

## Verification

| Check | Result |
|---|---|
| Unit + property tests (`npm test`, vitest + fast-check): money math, journal validation, reversal nets to zero | ✅ 31 passed |
| Typecheck / build | ✅ No new errors (the same 5 errors as before remain) / ✅ build passes |
| Browser smoke test | ✅ New routes load; signed-out users are redirected to sign-in; no console errors |
| **Database tests** `supabase/tests/phase2_ledger_engine_test.sql`, 43 pgTAP checks covering V1–V8, V10, V13, V15, V16, void/reverse, lock date, invoice + tax + payment posting, cross-business isolation, team access | ⏳ **Not run.** No database is available here; run on staging with `supabase test db` |
| Logged-in UI flows | ⏳ Not run (no test account) |

## Deploy notes
1. Apply on staging first, after Phase 0. Migration order is by filename.
2. After migrating, run this once per business and check every row returns `ok = true`:
   ```sql
   SELECT * FROM ledger_integrity('<business id>');
   ```
   `every_entry_balanced = false` points to **legacy** unbalanced entries recorded before the engine existed. They are listed, not changed.
3. Check for rows left from deleted accounts (they can't be given a business):
   ```sql
   SELECT count(*) FROM chart_of_accounts WHERE business_id IS NULL;
   ```

## Not in this part (Phase 2 part B and later)
- Opening-balance wizard and chart-of-accounts templates by industry.
- Migration of historical invoices, expenses and payroll into the ledger (needs your decision).
- Payroll summary entries.
- `business_id` on module tables (invoices, bills, bank transactions). That arrives in Phases 3–4.
- Reports still read the old sources; they move to `ledger_lines` in Phase 5.
- Chart of Accounts screen: account numbers / class editing UI; the old "edit balance" button still edits a stored number (removed in Phase 5).
