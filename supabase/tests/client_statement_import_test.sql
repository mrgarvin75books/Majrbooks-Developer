-- pgTAP tests for client bank-statement imports
-- (20261107100000_client_statement_transactions.sql and
--  20261110100000_fix_client_statement_owner_trigger.sql).
--
-- Run against a LOCAL or STAGING database (never production): npm run test:db
-- Everything runs inside one transaction and is rolled back.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(6);

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
  ('00000000-0000-0000-0000-0000000005a1', 'stmt-firm-a@test.local', '{}', now()),
  ('00000000-0000-0000-0000-0000000005b1', 'stmt-firm-b@test.local', '{}', now());

INSERT INTO public.clients (id, user_id, client_name) VALUES
  ('50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000005a1', 'Client of A'),
  ('50000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000005b1', 'Client of B');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005a1","role":"authenticated"}', true);

-- The bug: this insert failed with: record "new" has no field "import_id"
SELECT lives_ok(
  $$INSERT INTO public.client_statement_imports (id, client_id, file_name, sheet_name, row_count)
    VALUES ('51000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-00000000000a', 'statement.xlsx', 'Sheet1', 1)$$,
  'firm can record an import for its own client');

SELECT is(
  (SELECT user_id FROM public.client_statement_imports WHERE id = '51000000-0000-0000-0000-000000000001'),
  '00000000-0000-0000-0000-0000000005a1'::uuid,
  'import owner is copied from the client');

SELECT lives_ok(
  $$INSERT INTO public.client_statement_transactions
      (client_id, import_id, txn_date, description, amount, direction, type, category, fingerprint)
    VALUES ('50000000-0000-0000-0000-00000000000a', '51000000-0000-0000-0000-000000000001',
            '2026-01-05', 'Fuel', 16.00, 'out', 'expense', 'Car and truck expenses', 'fp-1')$$,
  'firm can save a statement line under that import');

SELECT is(
  (SELECT count(*)::int FROM public.client_statement_transactions WHERE client_id = '50000000-0000-0000-0000-00000000000a'),
  1, 'the line is saved for the client');

-- An import of client A can't be attached to a line of another client.
RESET ROLE;
SELECT throws_like(
  $$INSERT INTO public.client_statement_transactions
      (client_id, import_id, txn_date, description, amount, direction, type, category, fingerprint)
    VALUES ('50000000-0000-0000-0000-00000000000b', '51000000-0000-0000-0000-000000000001',
            '2026-01-05', 'Fuel', 16.00, 'out', 'expense', 'Car and truck expenses', 'fp-2')$$,
  '%different client%',
  'a line cannot point at another client''s import');

-- Firm B can't add imports for firm A's client.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005b1","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.client_statement_imports (client_id, file_name)
    VALUES ('50000000-0000-0000-0000-00000000000a', 'x.csv')$$,
  '42501', NULL,
  'another firm cannot import for this client');

SELECT * FROM finish();
ROLLBACK;
