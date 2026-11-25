-- pgTAP tests for the Client Messages inbox (20261125100000_client_messages_inbox.sql).
--
-- Run against a LOCAL or STAGING database (never production): npm run test:db
-- Everything runs inside one transaction and is rolled back.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(14);

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
  ('00000000-0000-0000-0000-0000000007a1', 'inbox-firm-a@test.local', '{}', now()),
  ('00000000-0000-0000-0000-0000000007b1', 'inbox-firm-b@test.local', '{}', now()),
  ('00000000-0000-0000-0000-0000000007c1', 'inbox-client-a@test.local', '{"full_name":"Carla Client"}', now()),
  ('00000000-0000-0000-0000-0000000007d1', 'inbox-staff-a@test.local', '{}', now());

INSERT INTO public.app_user_roles (user_id, role)
VALUES ('00000000-0000-0000-0000-0000000007c1', 'client')
ON CONFLICT DO NOTHING;
DELETE FROM public.app_user_roles WHERE user_id = '00000000-0000-0000-0000-0000000007c1' AND role <> 'client';

INSERT INTO public.team_members (owner_id, user_id, email, first_name, last_name, role, is_active)
VALUES ('00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007d1',
        'inbox-staff-a@test.local', 'Sam', 'Staff', 'staff', true);

INSERT INTO public.client_invitations (user_id, firm_id, client_email, client_name, client_user_id, status, used_at)
VALUES ('00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007a1',
        'inbox-client-a@test.local', 'Carla Client', '00000000-0000-0000-0000-0000000007c1', 'accepted', now());

-- Client starts a conversation from the chat widget.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007c1","role":"authenticated"}', true);
SELECT lives_ok(
  $$SELECT * FROM public.inbox_start_thread('Invoice question', 'Why is my invoice higher this month?')$$,
  'client can start a conversation');
SELECT is((SELECT count(*)::int FROM public.inbox_threads), 1, 'client sees their conversation');

RESET ROLE;
SELECT is(
  (SELECT firm_owner_id FROM public.inbox_threads WHERE subject = 'Invoice question'),
  '00000000-0000-0000-0000-0000000007a1'::uuid,
  'the conversation is addressed to the firm that invited the client');
SELECT is(
  (SELECT count(*)::int FROM public.notifications
   WHERE notification_type = 'client_message'
     AND user_id IN ('00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007d1')),
  2, 'firm owner and team member get a bell notification');

-- Firm owner and team member can read it; another firm cannot.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007a1","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.inbox_threads WHERE subject = 'Invoice question'), 1, 'firm owner sees it');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007b1","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.inbox_threads WHERE subject = 'Invoice question'), 0, 'another firm does not see it');
SELECT is((SELECT count(*)::int FROM public.inbox_messages), 0, 'another firm cannot read its messages');
SELECT throws_like(
  $$SELECT public.inbox_reply((SELECT id FROM public.inbox_threads WHERE subject = 'Invoice question'), 'x')$$,
  '%not found%', 'another firm cannot reply');

-- Team member replies.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007d1","role":"authenticated"}', true);
SELECT lives_ok(
  $$SELECT public.inbox_reply((SELECT id FROM public.inbox_threads WHERE subject = 'Invoice question'), 'Let me check.')$$,
  'team member can reply');
SELECT is(
  (SELECT status || '/' || requester_unread::text FROM public.inbox_threads WHERE subject = 'Invoice question'),
  'pending/true', 'staff reply marks it waiting on the client and unread for them');

-- The client cannot change status or write messages directly.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007c1","role":"authenticated"}', true);
SELECT throws_like(
  $$SELECT public.inbox_update_thread((SELECT id FROM public.inbox_threads WHERE subject = 'Invoice question'), 'closed')$$,
  '%not found%', 'client cannot close the conversation');
SELECT throws_ok(
  $$INSERT INTO public.inbox_messages (thread_id, author_type, author_name, body)
    SELECT id, 'staff', 'Fake', 'spoof' FROM public.inbox_threads LIMIT 1$$,
  '42501', NULL, 'messages cannot be inserted directly');

-- Logged-out visitors can write in but cannot read anything back.
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '', true);
SELECT lives_ok(
  $$SELECT * FROM public.inbox_start_thread('Pricing', 'How much is it?', 'chat_widget', 'Vic Visitor', 'vic@example.com')$$,
  'visitor can send a message with name and email');
SELECT throws_ok(
  $$SELECT public.inbox_ingest('a', 'a@b.co', 's', 'b', 'email')$$,
  '42501', NULL, 'visitors cannot call the server-only intake');

SELECT * FROM finish();
ROLLBACK;
