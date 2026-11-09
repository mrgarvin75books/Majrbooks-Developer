# Phase 0 — Security & Integrity Hotfixes: Completion Report

Branch: `phase-0-security` · Date: 2026-11-04 · Based on `docs/AUDIT-2026-11-04.md`

## Status at a glance

| Check | Result |
|---|---|
| Frontend typecheck (`tsc`) | ✅ No new errors. The same 5 errors that existed before remain; they're scheduled for Phase 9. |
| Production build (`vite build`) | ✅ Passes |
| Edge function typecheck (`tsc` with Deno stubs; 22 files) | ✅ Passes |
| Browser smoke test (local preview) | ✅ `/auth` renders; signed-out `/dashboard` → `/auth`; `?firm=` link rejected; no console errors |
| Database tests (`supabase/tests/phase0_security_test.sql`, 16 pgTAP checks) | ⏳ **Not run.** There is no Docker or linked project here, so run them on staging. |
| Edge functions against real Supabase | ⏳ **Not run.** They need a deploy to staging. |
| Logged-in flows (owner, team member, client) | ⏳ **Not run.** No test accounts are available here. |

## What changed

### Edge functions (17 functions + new `supabase/functions/_shared/security.ts`)
Every service-role function now establishes who is calling and checks that the caller owns the rows it touches. Values that go into emails are read from the database and HTML-escaped; they are no longer taken from the request body.

| Function | Before | After |
|---|---|---|
| `send-team-invite` | Anyone could re-token any seat and email it anywhere | Caller must own the seat. Email, name and role come from the `team_members` row. |
| `send-invoice` | No auth; any invoice could be emailed or have its status changed | Signed-in owner, or internal recurring job only. Invoice fields are escaped. |
| `analyze-receipt` | No auth; fetched any URL (SSRF); overwrote any receipt | Caller must own the receipt. The file is read from storage by `file_path`; any `imageUrl` sent is ignored. 15 MB cap. |
| `send-client-invitation` | Open email relay; `?firm=` fallback link | Caller must own the invitation. Resend-by-email rotates the token on the server. Token links only. |
| `send-login-notification` | Emailed any address | Login: the caller's own email. Signup: account under 15 minutes old, welcome sent once (`app_metadata.welcome_email_sent`), skipped for invited accounts. |
| `trigger-payment-workflow` | Trusted `userId`/`invoiceId` from the body | Owner and invoice are taken from the payment, which the caller must own. |
| `execute-workflow` | Rejected internal calls, so payment and overdue triggers never ran | Accepts internal calls. User calls are still limited to the user's own workflows. |
| `check-overdue-invoices` | Public; processed every account | Scheduler processes all accounts; a signed-in user processes only their own. |
| `generate-recurring-invoices`, `generate-recurring-tasks` | Public | Scheduler or internal callers only. |
| `setup-storage`, `schedule-c-analyze` | Public | Signed-in only. Schedule C adds size limits. |
| `analyze-bank-statement`, `analyze-client-document` | SSRF via `fileUrl` | `fileUrl` must point to this project's storage. Bank statement: the account must be the caller's. |
| `send-time-entry-notification` | Read any time entry | Caller must own the employee record. |
| `check-subscription` | **Crashed (500) for active paid subscriptions**; app trial overrode paid status | Reads `current_period_end` from the subscription item (API version `2025-08-27.basil`). Stripe is checked first and the app trial is the fallback. |
| `create-checkout` | Any `priceId`; repeatable trials; redirect to any `Origin` | Price allowlist; trial only for customers who have never subscribed; redirects only to known app origins. |
| `customer-portal` | Return URL taken from any `Origin` | Known app origins only. |

### Database migration `20261104130000_phase0_security_hardening.sql`
1. **Client role restored.** `client` is granted only when the signup is flagged `is_client` **and** a live invitation exists for that email. Existing invited clients who were given `user` are backfilled to `client`.
2. **Invoice payments** require ownership of the invoice, enforced by RLS plus a trigger that also rejects amounts of zero or less.
3. **Support tickets.** Anonymous tickets are no longer world-readable, and tickets can't be forged under another user's id. Logged-out visitors submit through `create_support_ticket()`.
4. **Invite RPCs** (`accept_team_invite`, `mark_invitation_used`) bind only the account created for the invited email address. `mark_invitation_used` now also creates the firm's `clients` record on the server; the browser previously wrote it into another firm's rows.
5. **`accrue_pto_for_payroll`** acts only as the caller.
6. **Trial.** `profiles.trial_ends_at` can't be changed through the API. `start_free_trial()` grants a trial once and never extends one.
7. **Notifications** can only be addressed to people in the sender's firm.
8. **`assets` bucket.** Only admins can upload.

### Frontend
- **Roles.** `AuthContext` now distinguishes:
  - `isAdmin`: platform admin.
  - `isOwner`: self-signed-up account.
  - `isStaff`: invited team member, covered by the owner's plan.
  - `isClient`: invited client.

  Previously every owner counted as "staff", which skipped the paywall and trial UI.
- **Route-guard race fixed.** `loading` stays true until the role is known, and token refreshes no longer flash a spinner.
- **New `requireOwner` guard.** Owners can now reach Team, User Permissions, Firm Subscriptions and Billing Details. The other billing and admin pages stay admin-only. Sidebar links mirror the guards, so nothing links to a redirect.
- **`usePermissions`** gives clients no practice-module access.
- **Client invites.**
  - `AcceptClientInvite` rejects old `?firm=` links.
  - Invitation linking now goes through the RPC.
  - Linking failures are reported to the user instead of being swallowed.
- **Dashboard "Resend invitation"** reports failures instead of always showing success.
- **Trial and support forms.**
  - `Auth` uses `start_free_trial()`, and the client-side trial write was removed.
  - `ContactSupport` uses `create_support_ticket()`.
- **Bills.** The Expenses → Bills tab now reads and writes `bills` instead of `invoices`, so new vendor bills no longer post revenue.
- **Quick-add dialogs.**
  - Quick Add Expense stores a positive amount; it previously always failed.
  - Quick Add Credit now explains that credit memos return in Phase 5. It previously always failed, and if it had worked it would have posted negative revenue.

## Deployment — order matters

The new frontend calls `start_free_trial` and `create_support_ticket`. Those functions must exist before the frontend ships.

1. **Back up production**, or confirm point-in-time recovery is on.
2. **Apply to staging first**, run the tests, and smoke-test the flows listed below:
   ```bash
   supabase db push            # against the staging project
   supabase test db            # runs supabase/tests/phase0_security_test.sql
   supabase functions deploy   # deploys all functions incl. _shared
   ```
3. **Set new secrets** in Supabase → Edge Functions → Secrets:
   - `CRON_SECRET`: required. A long random string.
   - `STRIPE_ALLOWED_PRICE_IDS`: optional. Comma-separated price IDs to allow beyond Starter and Professional monthly, e.g. yearly prices once they exist in Stripe.
   - `ALLOWED_APP_ORIGINS`: optional. Extra origins for Stripe redirects, e.g. a Vercel preview URL.
4. **Update the scheduler.** Whatever calls `generate-recurring-invoices`, `generate-recurring-tasks` and `check-overdue-invoices` on a schedule (pg_cron or an external cron) must send the header `x-cron-secret: <CRON_SECRET>`. **Until it does, those jobs return 401 and stop running.** No schedule is defined in this repo, so it was set up in the dashboard **[verify live]**.
5. Repeat steps 2–4 on production, then deploy the frontend (Vercel).

### Smoke test checklist (staging)
- [ ] Owner signup → 14-day trial banner shows. After the trial: redirected to plan selection.
- [ ] Owner sees Team, User Permissions and Billing → Firm subscriptions / Billing details. Team member and client don't.
- [ ] Invite a team member → email arrives → accept → team member signs in.
- [ ] Invite a client → accept → lands in the client portal (not the staff app) → firm sees the client in its list.
- [ ] Record an invoice payment → payment-received workflow runs (if one is configured).
- [ ] Paid Stripe subscriber → status loads (no 500).
- [ ] Add a bill on Expenses → it appears under Bills, not under Invoices.
- [ ] Logged-out support ticket → ticket number shown.

## Things you should know

1. **Existing bad data is untouched.** Bills added through the old Expenses page were saved as invoices numbered `BILL-…`, and any that left draft status posted Dr AR / Cr Revenue. Following "never silently delete posted financial history", I didn't change them. To see the scope:
   ```sql
   SELECT i.id, i.user_id, i.invoice_number, i.client_name, i.amount, i.status, i.created_at,
          (SELECT count(*) FROM journal_entries je
            WHERE je.source_type = 'invoice' AND je.source_id = i.id) AS journal_entries
   FROM invoices i
   WHERE i.invoice_number LIKE 'BILL-%'
   ORDER BY i.created_at;
   ```
   The fix (move them to `bills` and post reversing entries) belongs in Phase 3, once reversals exist.
2. **Visible behaviour changes:**
   - Owners whose trial has ended now see the plan-selection paywall.
   - Wrongly-roled invited clients move to the client portal.
   - Old `?firm=` invitation links stop working.
   - Scheduled jobs need the cron secret.
3. **Workflow email action.** It was already broken: `execute-workflow` calls `send-invoice` with `to/subject/html`, which `send-invoice` never supported. It still doesn't send. It now fails with a clear 400 instead of a 500. Fixing it is a small Phase 5 item.
4. **Still open**, and not part of Phase 0:
   - `payouts` and `referrals` remain user-editable. The billing pages that use them are admin-only.
   - The admin role is still granted by email in the signup trigger.
   - `has_app_role` / `get_team_member_permissions` can be queried for any user id.
   - Wildcard CORS.
   - The `client-documents` / `bank-statements` storage bucket policies are still not in migrations. (`clients` and `documents` are now created by `20251103172900_base_clients_and_documents.sql` from `main`.)
   - Team members still see empty books, because RLS is owner-only. That's Phase 3/7: entity membership.
