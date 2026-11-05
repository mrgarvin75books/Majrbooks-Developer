-- pgTAP tests for the Phase 2 ledger engine
--   supabase/migrations/20261105100000_phase2_businesses.sql
--   supabase/migrations/20261105110000_phase2_ledger_engine.sql
--
-- Run against a LOCAL or STAGING database (never production):
--   supabase start && supabase db reset && supabase test db
-- Everything runs in one transaction and is rolled back.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(43);

-- ---------------------------------------------------------------------------
-- Fixtures (as the migration owner)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, v UUID);
CREATE FUNCTION pg_temp.id(p TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;
-- A procedure so switching users prints nothing into the TAP stream.
CREATE PROCEDURE pg_temp.act_as(p_user UUID) LANGUAGE sql AS $
  SELECT set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$;
CREATE FUNCTION pg_temp.bal(p_business UUID, p_account UUID) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(sum(CASE WHEN a.normal_balance = 'credit' THEN l.credit - l.debit ELSE l.debit - l.credit END), 0)
  FROM public.ledger_lines l JOIN public.chart_of_accounts a ON a.id = l.account_id
  WHERE l.business_id = p_business AND l.account_id = p_account;
$$;
CREATE FUNCTION pg_temp.sys(p_business UUID, p_key TEXT) RETURNS UUID LANGUAGE sql AS $$
  SELECT id FROM public.chart_of_accounts WHERE business_id = p_business AND system_key = p_key;
$$;

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@test.local', '{"full_name":"Owner A"}', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@test.local', '{"full_name":"Owner B"}', now()),
  ('00000000-0000-0000-0000-0000000000c1', 'staff-a@test.local', '{"full_name":"Accountant at A","is_team_member":true}', now());

INSERT INTO ids VALUES
  ('A', '00000000-0000-0000-0000-0000000000a1'),
  ('B', '00000000-0000-0000-0000-0000000000b1'),
  ('C', '00000000-0000-0000-0000-0000000000c1');
INSERT INTO ids SELECT 'bizA', public.ensure_default_business(pg_temp.id('A'));
INSERT INTO ids SELECT 'bizB', public.ensure_default_business(pg_temp.id('B'));

INSERT INTO public.chart_of_accounts (user_id, business_id, name, account_type, detail_type)
VALUES (pg_temp.id('A'), pg_temp.id('bizA'), 'Office Supplies', 'Expense', 'OfficeExpenses'),
       (pg_temp.id('A'), pg_temp.id('bizA'), 'Checking', 'Bank', 'Checking'),
       (pg_temp.id('B'), pg_temp.id('bizB'), 'B Checking', 'Bank', 'Checking');
INSERT INTO ids SELECT 'expA', id FROM public.chart_of_accounts WHERE name = 'Office Supplies' AND business_id = pg_temp.id('bizA');
INSERT INTO ids SELECT 'bankA', id FROM public.chart_of_accounts WHERE name = 'Checking' AND business_id = pg_temp.id('bizA');
INSERT INTO ids SELECT 'bankB', id FROM public.chart_of_accounts WHERE name = 'B Checking';

-- ---------------------------------------------------------------------------
-- Businesses and chart of accounts
-- ---------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM public.chart_of_accounts
           WHERE business_id = pg_temp.id('bizA') AND is_system), 9,
          'a new business gets its 9 system accounts');
SELECT is((SELECT account_class FROM public.chart_of_accounts WHERE id = pg_temp.id('bankA')), 'asset',
          'QuickBooks-style "Bank" type is classified as an asset');
SELECT is((SELECT normal_balance FROM public.chart_of_accounts WHERE id = pg_temp.id('expA')), 'debit',
          'expense accounts have a debit normal balance');

-- ---------------------------------------------------------------------------
-- Posting rules, acting as owner A
-- ---------------------------------------------------------------------------
CALL pg_temp.act_as(pg_temp.id('A'));

INSERT INTO ids SELECT 'je1', public.post_journal_entry(
  pg_temp.id('bizA'), '2026-03-10', 'Supplies', NULL,
  jsonb_build_array(
    jsonb_build_object('account_id', pg_temp.id('expA'), 'debit', '125.40'),
    jsonb_build_object('account_id', pg_temp.id('bankA'), 'credit', '125.40')),
  'key-1');

SELECT is((SELECT status FROM public.journal_entries WHERE id = pg_temp.id('je1')), 'posted', 'balanced entry posts');
SELECT matches((SELECT entry_number FROM public.journal_entries WHERE id = pg_temp.id('je1')), '^JE-\d{6}$',
               'entries get a sequential number');
SELECT is(pg_temp.bal(pg_temp.id('bizA'), pg_temp.id('expA')), 125.40::numeric, 'expense balance comes from the ledger');

SELECT is(public.post_journal_entry(
  pg_temp.id('bizA'), '2026-03-10', 'Supplies', NULL,
  jsonb_build_array(
    jsonb_build_object('account_id', pg_temp.id('expA'), 'debit', '125.40'),
    jsonb_build_object('account_id', pg_temp.id('bankA'), 'credit', '125.40')),
  'key-1'), pg_temp.id('je1'), 'V8: same idempotency key returns the original entry');

SELECT throws_like($$ SELECT public.post_journal_entry(pg_temp.id('bizA'), '2026-03-10', 'x', NULL,
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.id('expA'), 'debit', '10.00'),
                    jsonb_build_object('account_id', pg_temp.id('bankA'), 'credit', '9.99'))) $$,
  'ENTRY_UNBALANCED%', 'V1: unbalanced entries are rejected (one cent off)');

SELECT throws_like($$ SELECT public.post_journal_entry(pg_temp.id('bizA'), '2026-03-10', 'x', NULL,
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.id('expA'), 'debit', '10', 'credit', '10'),
                    jsonb_build_object('account_id', pg_temp.id('bankA'), 'credit', '0'))) $$,
  'INVALID_LINE%', 'V2: a line cannot be both a debit and a credit');

SELECT throws_like($$ SELECT public.post_journal_entry(pg_temp.id('bizA'), '2026-03-10', 'x', NULL,
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.id('expA'), 'debit', '10')) ) $$,
  'INVALID_LINE%', 'V2: an entry needs at least two lines');

SELECT throws_like($$ SELECT public.post_journal_entry(pg_temp.id('bizA'), '2026-03-10', 'x', NULL,
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.id('expA'), 'debit', '1.005'),
                    jsonb_build_object('account_id', pg_temp.id('bankA'), 'credit', '1.005'))) $$,
  'INVALID_AMOUNT%', 'V15: sub-cent amounts are rejected');

SELECT throws_like($$ SELECT public.post_journal_entry(pg_temp.id('bizA'), '2026-03-10', 'x', NULL,
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.id('expA'), 'debit', '5'),
                    jsonb_build_object('account_id', pg_temp.id('bankB'), 'credit', '5'))) $$,
  'CROSS_BUSINESS_REFERENCE%', 'V3: cannot post to another business''s account');

SELECT throws_like($$ SELECT public.post_journal_entry(pg_temp.id('bizB'), '2026-03-10', 'x', NULL,
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.id('bankB'), 'debit', '5'),
                    jsonb_build_object('account_id', pg_temp.id('bankB'), 'credit', '5'))) $$,
  'NOT_FOUND%', 'cannot post into a business you are not a member of');

-- Direct writes through the API are not possible
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ INSERT INTO public.journal_entries (user_id, business_id, entry_number, status)
                   VALUES (pg_temp.id('A'), pg_temp.id('bizA'), 'HACK', 'posted') $$,
                 '42501', NULL, 'journal entries cannot be inserted directly');
UPDATE public.journal_entries SET description = 'tampered' WHERE id = pg_temp.id('je1');
RESET ROLE;
SELECT is((SELECT description FROM public.journal_entries WHERE id = pg_temp.id('je1')), 'Supplies',
          'journal entries cannot be updated directly through the API');

-- V4 even for privileged code paths
SELECT throws_like($$ UPDATE public.journal_entries SET description = 'x' WHERE id = pg_temp.id('je1') $$,
                   'ENTRY_IMMUTABLE%', 'V4: posted entries cannot be edited');
SELECT throws_like($$ DELETE FROM public.journal_entries WHERE id = pg_temp.id('je1') $$,
                   'ENTRY_IMMUTABLE%', 'V4: posted entries cannot be deleted');
SELECT throws_like($$ UPDATE public.journal_entry_lines SET debit = 1 WHERE journal_entry_id = pg_temp.id('je1') AND debit > 0 $$,
                   'ENTRY_IMMUTABLE%', 'V4: lines of posted entries cannot be edited');

-- ---------------------------------------------------------------------------
-- Void and reverse
-- ---------------------------------------------------------------------------
CALL pg_temp.act_as(pg_temp.id('A'));
SELECT throws_like($$ SELECT public.void_journal_entry(pg_temp.id('je1'), '') $$,
                   'REASON_REQUIRED%', 'voiding requires a reason');
INSERT INTO ids SELECT 'void1', public.void_journal_entry(pg_temp.id('je1'), 'Entered twice');
SELECT is((SELECT status FROM public.journal_entries WHERE id = pg_temp.id('je1')), 'voided', 'void marks the original voided');
SELECT is((SELECT entry_date FROM public.journal_entries WHERE id = pg_temp.id('void1')), '2026-03-10'::date,
          'the void''s reversing entry is dated the same day');
SELECT is(pg_temp.bal(pg_temp.id('bizA'), pg_temp.id('expA')), 0::numeric, 'original + void nets to zero');

INSERT INTO ids SELECT 'je2', public.post_journal_entry(
  pg_temp.id('bizA'), '2026-03-31', 'Accrued supplies', NULL,
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.id('expA'), 'debit', '40'),
                    jsonb_build_object('account_id', pg_temp.sys(pg_temp.id('bizA'), 'accounts_payable'), 'credit', '40')));
INSERT INTO ids SELECT 'rev2', public.reverse_journal_entry(pg_temp.id('je2'), '2026-04-01');
SELECT is((SELECT status FROM public.journal_entries WHERE id = pg_temp.id('je2')), 'posted', 'reverse keeps the original posted');
SELECT throws_like($$ SELECT public.reverse_journal_entry(pg_temp.id('je2'), '2026-04-02') $$,
                   'ALREADY_REVERSED%', 'an entry can only be reversed once');

-- ---------------------------------------------------------------------------
-- V5 lock date
-- ---------------------------------------------------------------------------
SELECT lives_ok($ SELECT public.set_lock_date(pg_temp.id('bizA'), '2026-03-31', NULL) $, 'books can be closed through a date');
SELECT throws_like($$ SELECT public.post_journal_entry(pg_temp.id('bizA'), '2026-03-15', 'late', NULL,
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.id('expA'), 'debit', '5'),
                    jsonb_build_object('account_id', pg_temp.id('bankA'), 'credit', '5'))) $$,
  'PERIOD_LOCKED%', 'V5: cannot post into a closed period');
SELECT throws_like($$ SELECT public.set_lock_date(pg_temp.id('bizA'), '2026-02-28', '') $$,
                   'REASON_REQUIRED%', 'reopening a closed period needs a reason');
SELECT ok(EXISTS (SELECT 1 FROM public.audit_logs WHERE business_id = pg_temp.id('bizA') AND action = 'lock_date_changed'),
          'lock date changes are audited');
SELECT lives_ok($ SELECT public.set_lock_date(pg_temp.id('bizA'), NULL, 'tests continue in March') $, 'a closed period can be reopened with a reason');

-- ---------------------------------------------------------------------------
-- V6 / V16 accounts
-- ---------------------------------------------------------------------------
RESET ROLE;
SELECT throws_like($$ DELETE FROM public.chart_of_accounts WHERE id = pg_temp.id('expA') $$,
                   'ACCOUNT_IN_USE%', 'accounts with transactions cannot be deleted');
SELECT throws_like($$ DELETE FROM public.chart_of_accounts WHERE id = pg_temp.sys(pg_temp.id('bizA'), 'accounts_receivable') $$,
                   'SYSTEM_ACCOUNT%', 'V16: system accounts cannot be deleted');
UPDATE public.chart_of_accounts SET is_active = false WHERE id = pg_temp.id('expA');
CALL pg_temp.act_as(pg_temp.id('A'));
SELECT throws_like($$ SELECT public.post_journal_entry(pg_temp.id('bizA'), '2026-05-01', 'x', NULL,
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.id('expA'), 'debit', '5'),
                    jsonb_build_object('account_id', pg_temp.id('bankA'), 'credit', '5'))) $$,
  'ACCOUNT_ARCHIVED%', 'V6: inactive accounts cannot receive new lines');

-- ---------------------------------------------------------------------------
-- Invoices and payments post through the engine
-- ---------------------------------------------------------------------------
RESET ROLE;
INSERT INTO public.invoices (id, user_id, client_name, invoice_number, amount, subtotal, tax, issue_date, due_date, status)
VALUES ('30000000-0000-0000-0000-000000000001', pg_temp.id('A'), 'Acme', 'INV-1', 108.00, 100.00, 8.00,
        '2026-05-01', '2026-05-31', 'pending');
SELECT is(pg_temp.bal(pg_temp.id('bizA'), pg_temp.sys(pg_temp.id('bizA'), 'sales_tax_payable')), 8::numeric,
          'invoice tax is credited to Sales Tax Payable, not revenue');
SELECT is(pg_temp.bal(pg_temp.id('bizA'), pg_temp.sys(pg_temp.id('bizA'), 'sales')), 100::numeric,
          'invoice subtotal is credited to Sales');

INSERT INTO public.invoice_payments (id, invoice_id, user_id, amount, payment_date)
VALUES ('30000000-0000-0000-0000-000000000101', '30000000-0000-0000-0000-000000000001', pg_temp.id('A'), 50, '2026-05-10');
SELECT is(pg_temp.bal(pg_temp.id('bizA'), pg_temp.sys(pg_temp.id('bizA'), 'accounts_receivable')), 58::numeric,
          'payment reduces Accounts Receivable');
SELECT throws_like($$ INSERT INTO public.invoice_payments (invoice_id, user_id, amount)
                      VALUES ('30000000-0000-0000-0000-000000000001', pg_temp.id('A'), 100) $$,
                   'OVERAPPLIED%', 'V10: payments cannot exceed the open balance');
SELECT throws_like($$ UPDATE public.invoices SET status = 'cancelled' WHERE id = '30000000-0000-0000-0000-000000000001' $$,
                   'INVOICE_HAS_PAYMENTS%', 'an invoice with payments cannot be cancelled');

UPDATE public.invoices SET amount = 216.00, subtotal = 200.00, tax = 16.00 WHERE id = '30000000-0000-0000-0000-000000000001';
SELECT is(pg_temp.bal(pg_temp.id('bizA'), pg_temp.sys(pg_temp.id('bizA'), 'accounts_receivable')), 166::numeric,
          'editing an invoice voids and re-posts it (216 - 50 paid)');

DELETE FROM public.invoice_payments WHERE id = '30000000-0000-0000-0000-000000000101';
DELETE FROM public.invoices WHERE id = '30000000-0000-0000-0000-000000000001';
SELECT is(pg_temp.bal(pg_temp.id('bizA'), pg_temp.sys(pg_temp.id('bizA'), 'accounts_receivable')), 0::numeric,
          'deleting the payment and invoice voids their entries (history kept)');

-- ---------------------------------------------------------------------------
-- Integrity, isolation, team access
-- ---------------------------------------------------------------------------
CALL pg_temp.act_as(pg_temp.id('A'));
SELECT ok((SELECT bool_and(ok) FROM public.ledger_integrity(pg_temp.id('bizA'))),
          'V13: trial balance nets to zero and every entry balances');

SET LOCAL ROLE authenticated;
CALL pg_temp.act_as(pg_temp.id('B'));
SELECT is((SELECT count(*)::int FROM public.journal_entries WHERE business_id = pg_temp.id('bizA')), 0,
          'another business cannot read A''s journal entries');
SELECT is((SELECT count(*)::int FROM public.chart_of_accounts WHERE business_id = pg_temp.id('bizA')), 0,
          'another business cannot read A''s chart of accounts');
RESET ROLE;

INSERT INTO public.team_members (owner_id, user_id, email, first_name, last_name, role, is_active)
VALUES (pg_temp.id('A'), pg_temp.id('C'), 'staff-a@test.local', 'Acc', 'Ountant', 'accountant', true);
CALL pg_temp.act_as(pg_temp.id('C'));
SELECT ok(public.post_journal_entry(pg_temp.id('bizA'), '2026-06-01', 'by accountant', NULL,
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.id('bankA'), 'debit', '1'),
                    jsonb_build_object('account_id', pg_temp.sys(pg_temp.id('bizA'), 'uncategorized_income'), 'credit', '1'))) IS NOT NULL,
  'an accountant on the owner''s team can keep the owner''s books');

SELECT * FROM finish();
ROLLBACK;
