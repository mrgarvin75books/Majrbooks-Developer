-- pgTAP tests for supabase/migrations/20261104120000_phase0_security_hardening.sql
--
-- Run against a LOCAL or STAGING database (never production):
--   supabase start && supabase db reset && supabase test db
--
-- Everything runs inside one transaction and is rolled back.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(16);

-- ---------------------------------------------------------------------------
-- Fixtures (inserted as the migration owner, bypassing RLS)
-- ---------------------------------------------------------------------------
-- Two firms (A, B), an attacker (X), and accounts for invite tests.
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'firm-a@test.local', '{"full_name":"Firm A"}', now()),
  ('00000000-0000-0000-0000-00000000000b', 'firm-b@test.local', '{"full_name":"Firm B"}', now()),
  ('00000000-0000-0000-0000-0000000000ff', 'attacker@test.local', '{}', now());

INSERT INTO public.invoices (id, user_id, client_name, invoice_number, amount, due_date)
VALUES ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a',
        'Customer of A', 'A-1', 100.00, current_date + 30);

INSERT INTO public.support_tickets (user_id, name, email, category, subject, message, ticket_number)
VALUES (NULL, 'Anon Person', 'anon@test.local', 'general', 'Private', 'Secret message', 'TEMP');

INSERT INTO public.team_members (id, owner_id, email, first_name, last_name, invite_token, invite_sent_at)
VALUES ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a',
        'staff@test.local', 'Staff', 'Member', 'team-token-1', now());

INSERT INTO public.client_invitations (user_id, firm_id, client_name, client_email, invite_token, expires_at, status)
VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a',
        'Invited Client', 'client@test.local', 'client-token-1', now() + interval '7 days', 'pending');

-- ---------------------------------------------------------------------------
-- 1. Signup role assignment
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'client@test.local', '{"is_client":true,"full_name":"Invited Client"}', now()),
  ('00000000-0000-0000-0000-0000000000c2', 'not-invited@test.local', '{"is_client":true}', now());

SELECT is(
  (SELECT role::text FROM public.app_user_roles WHERE user_id = '00000000-0000-0000-0000-0000000000c1'),
  'client', 'invited client signup gets the client role');

SELECT is(
  (SELECT role::text FROM public.app_user_roles WHERE user_id = '00000000-0000-0000-0000-0000000000c2'),
  'user', 'is_client flag without an invitation does not grant the client role');

SELECT is(
  (SELECT trial_ends_at FROM public.profiles WHERE id = '00000000-0000-0000-0000-0000000000c1'),
  NULL, 'invited client does not get a trial');

-- ---------------------------------------------------------------------------
-- Act as the attacker
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}', true);

-- 2. invoice_payments
SELECT throws_ok(
  $$ INSERT INTO public.invoice_payments (invoice_id, user_id, amount)
     VALUES ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000ff', 100) $$,
  NULL, 'cannot record a payment against another firm''s invoice');

-- 3. support tickets
SELECT is(
  (SELECT count(*)::int FROM public.support_tickets WHERE user_id IS NULL),
  0, 'anonymous tickets are not readable by other users');

SELECT throws_ok(
  $$ INSERT INTO public.support_tickets (user_id, name, email, category, subject, message, ticket_number)
     VALUES ('00000000-0000-0000-0000-00000000000a', 'X', 'x@test.local', 'general', 'Forged', 'Forged', 'TEMP') $$,
  NULL, 'cannot create a ticket under another user''s id');

SELECT ok(
  public.create_support_ticket('Me', 'me@test.local', 'general', 'medium', 'Help', 'Body') LIKE 'MJR-%',
  'create_support_ticket returns a ticket number');

-- 4. Invite RPCs
SELECT is(
  public.accept_team_invite('team-token-1', '00000000-0000-0000-0000-0000000000ff'),
  FALSE, 'attacker cannot bind their account to someone else''s team invite');

SELECT is(
  public.accept_team_invite('team-token-1', '00000000-0000-0000-0000-00000000000a'),
  FALSE, 'signed-in caller cannot bind a different user id');

SELECT is(
  public.mark_invitation_used('client-token-1', '00000000-0000-0000-0000-0000000000ff'),
  FALSE, 'attacker cannot claim a client invitation for another email');

-- 5. Trial protection
UPDATE public.profiles SET trial_ends_at = now() + interval '10 years'
WHERE id = '00000000-0000-0000-0000-0000000000ff';
SELECT ok(
  (SELECT trial_ends_at FROM public.profiles WHERE id = '00000000-0000-0000-0000-0000000000ff') < now() + interval '15 days',
  'users cannot extend their own trial');

SELECT ok(
  public.start_free_trial() < now() + interval '15 days',
  'start_free_trial never extends an existing trial');

-- 6. Notifications
SELECT throws_ok(
  $$ INSERT INTO public.notifications (user_id, recipient_id, notification_type, title)
     VALUES ('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000000b', 'info', 'spam') $$,
  NULL, 'cannot send notifications to users outside your firm');

-- 7. PTO accrual
SELECT throws_ok(
  $$ SELECT public.accrue_pto_for_payroll(gen_random_uuid(), '00000000-0000-0000-0000-00000000000a') $$,
  NULL, 'accrue_pto_for_payroll rejects a user id other than the caller');

-- ---------------------------------------------------------------------------
-- Positive path: the invited client accepting their own invitation
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
SELECT is(
  public.mark_invitation_used('client-token-1', '00000000-0000-0000-0000-0000000000c1'),
  TRUE, 'invited client can accept their own invitation');

RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.clients
   WHERE user_id = '00000000-0000-0000-0000-00000000000a' AND lower(email) = 'client@test.local'),
  1, 'accepting the invitation creates the firm''s client record');

SELECT * FROM finish();
ROLLBACK;
