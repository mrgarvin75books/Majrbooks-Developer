-- pgTAP tests for supabase/migrations/20261125100000_email_notifications.sql
--
-- Run against a LOCAL or STAGING database (never production):
--   npm run test:db        (or: supabase test db)
--
-- Everything runs inside one transaction and is rolled back.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(15);

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
  ('00000000-0000-0000-0000-0000000e0001', 'Email-Admin@test.local', '{}', now()),
  ('00000000-0000-0000-0000-0000000e0002', 'email-user@test.local', '{}', now());
-- The signup trigger gives every new account the 'user' role; make one an admin.
INSERT INTO public.app_user_roles (user_id, role)
VALUES ('00000000-0000-0000-0000-0000000e0001', 'admin')
ON CONFLICT (user_id, role) DO NOTHING;

-- ---------------------------------------------------------------------------
-- claim_email_send: duplicate suppression
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE t_ids (name TEXT PRIMARY KEY, id UUID);
GRANT ALL ON t_ids TO PUBLIC;

INSERT INTO t_ids SELECT 'first', public.claim_email_send(
  'signup_owner', 'New@Test.local', NULL, 'Subject', 'test:signup:1', NULL, '{"user_id":"x"}', NULL, NULL);
SELECT isnt((SELECT id FROM t_ids WHERE name = 'first'), NULL, 'first claim creates a log row');
SELECT is((SELECT recipient_email FROM public.email_logs WHERE id = (SELECT id FROM t_ids WHERE name = 'first')),
  'new@test.local', 'recipient is stored lower-cased');

SELECT is(public.claim_email_send(
  'signup_owner', 'new@test.local', NULL, 'Subject', 'test:signup:1', NULL, '{}', NULL, NULL),
  NULL, 'a second claim while the first is pending is suppressed');

UPDATE public.email_logs SET status = 'failed' WHERE id = (SELECT id FROM t_ids WHERE name = 'first');
INSERT INTO t_ids SELECT 'retry', public.claim_email_send(
  'signup_owner', 'new@test.local', NULL, 'Subject', 'test:signup:1', NULL, '{}', NULL, NULL);
SELECT isnt((SELECT id FROM t_ids WHERE name = 'retry'), NULL, 'a failed attempt does not block a retry');

UPDATE public.email_logs SET status = 'sent' WHERE id = (SELECT id FROM t_ids WHERE name = 'retry');
SELECT is(public.claim_email_send(
  'signup_owner', 'new@test.local', NULL, 'Subject', 'test:signup:1', NULL, '{}', NULL, NULL),
  NULL, 'with no window, a sent email is never sent again');

-- Windowed keys: an old 'sent' row no longer blocks.
INSERT INTO public.email_logs (template_key, recipient_email, status, dedupe_key, created_at)
VALUES ('staff_invitation', 'staff@test.local', 'sent', 'test:staff:1', now() - interval '5 minutes');
SELECT isnt(public.claim_email_send(
  'staff_invitation', 'staff@test.local', NULL, 'S', 'test:staff:1', 120, '{}', NULL, NULL),
  NULL, 'outside the window the same key may be sent again');
SELECT is(public.claim_email_send(
  'staff_invitation', 'staff@test.local', NULL, 'S', 'test:staff:1', 120, '{}', NULL, NULL),
  NULL, 'inside the window the same key is suppressed');

-- Abandoned pending rows (> 10 min) do not block forever.
INSERT INTO public.email_logs (template_key, recipient_email, status, dedupe_key, created_at)
VALUES ('password_changed', 'p@test.local', 'pending', 'test:stale:1', now() - interval '11 minutes');
SELECT isnt(public.claim_email_send(
  'password_changed', 'p@test.local', NULL, 'S', 'test:stale:1', NULL, '{}', NULL, NULL),
  NULL, 'a stale pending row is treated as abandoned');

-- Resend links the attempts together.
INSERT INTO t_ids SELECT 'resent', public.claim_email_send(
  'signup_owner', 'new@test.local', NULL, 'Subject', NULL, NULL, '{}', NULL, (SELECT id FROM t_ids WHERE name = 'first'));
SELECT is((SELECT superseded_by FROM public.email_logs WHERE id = (SELECT id FROM t_ids WHERE name = 'first')),
  (SELECT id FROM t_ids WHERE name = 'resent'), 'resending marks the original as superseded');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
SELECT is(public.find_auth_user_id_by_email('  email-admin@TEST.local '),
  '00000000-0000-0000-0000-0000000e0001'::uuid, 'user lookup by email ignores case and spaces');

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon', 'public.claim_email_send(text,text,uuid,text,text,integer,jsonb,uuid,uuid)', 'EXECUTE'),
  'anon cannot call claim_email_send');
SELECT ok(NOT has_function_privilege('authenticated', 'public.find_auth_user_id_by_email(text)', 'EXECUTE'),
  'signed-in users cannot look up accounts by email');
SELECT ok(NOT has_function_privilege('authenticated', 'public.revoke_user_sessions(uuid)', 'EXECUTE'),
  'signed-in users cannot revoke sessions');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000e0002","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.email_logs), 0, 'non-admins cannot read email logs');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000e0001","role":"authenticated"}', true);
SELECT ok((SELECT count(*) FROM public.email_logs) > 0, 'platform admins can read email logs');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
