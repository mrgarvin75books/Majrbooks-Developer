-- =============================================================================
-- Client Messages inbox
--
-- Clients (and website visitors) send messages from the chat widget, the
-- contact form, or by email. Each conversation is an inbox_thread; every
-- message in it is an inbox_message. Firm owners and their active team
-- members read and answer the threads of their own clients from /messages.
-- Platform admins see every thread.
--
-- firm_owner_id decides who receives a thread:
--   * a client user's thread goes to the firm that invited them
--     (client_invitations.user_id);
--   * everything else (firm users, logged-out visitors, contact form, inbound
--     email) has firm_owner_id NULL and goes to MAJRBooks support (admins).
--
-- All writes go through the SECURITY DEFINER functions below. Tables are
-- read-only to the browser through RLS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inbox_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_code TEXT NOT NULL UNIQUE
    DEFAULT 'MSG-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  firm_owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  requester_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  requester_name TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chat_widget'
    CHECK (source IN ('chat_widget', 'portal', 'contact_form', 'email')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending', 'closed')),
  staff_unread BOOLEAN NOT NULL DEFAULT true,
  requester_unread BOOLEAN NOT NULL DEFAULT false,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_preview TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbox_threads_firm ON public.inbox_threads(firm_owner_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_threads_requester ON public.inbox_threads(requester_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_threads_status ON public.inbox_threads(status);

CREATE TABLE IF NOT EXISTS public.inbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('requester', 'staff', 'system')),
  author_name TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 10000),
  via_email BOOLEAN NOT NULL DEFAULT false,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbox_messages_thread ON public.inbox_messages(thread_id, created_at);

DROP TRIGGER IF EXISTS update_inbox_threads_updated_at ON public.inbox_threads;
CREATE TRIGGER update_inbox_threads_updated_at
  BEFORE UPDATE ON public.inbox_threads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- -----------------------------------------------------------------------------
-- Access helpers
-- -----------------------------------------------------------------------------

-- True when the caller answers threads addressed to p_firm_owner_id:
-- the firm owner, an active team member of that firm, or a platform admin.
-- NULL firm (MAJRBooks support) is answered by platform admins only.
CREATE OR REPLACE FUNCTION public.inbox_is_staff_for(p_firm_owner_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.has_app_role(auth.uid(), 'admin')
    OR (p_firm_owner_id IS NOT NULL AND (
      p_firm_owner_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.owner_id = p_firm_owner_id AND tm.user_id = auth.uid() AND tm.is_active
      )
    ))
  );
$$;
REVOKE ALL ON FUNCTION public.inbox_is_staff_for(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_is_staff_for(UUID) TO authenticated;

-- The firm a client user belongs to (the most recent accepted invitation).
CREATE OR REPLACE FUNCTION public.inbox_firm_for_client(p_user_id UUID)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT ci.user_id
  FROM public.client_invitations ci
  WHERE ci.client_user_id = p_user_id
  ORDER BY (ci.status = 'accepted') DESC, coalesce(ci.used_at, ci.updated_at) DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.inbox_firm_for_client(UUID) FROM PUBLIC, anon, authenticated;

-- Everyone who should hear about a new message from the requester.
CREATE OR REPLACE FUNCTION public.inbox_staff_recipients(p_firm_owner_id UUID)
RETURNS TABLE (user_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_firm_owner_id WHERE p_firm_owner_id IS NOT NULL
  UNION
  SELECT tm.user_id FROM public.team_members tm
  WHERE p_firm_owner_id IS NOT NULL AND tm.owner_id = p_firm_owner_id
    AND tm.is_active AND tm.user_id IS NOT NULL
  UNION
  SELECT r.user_id FROM public.app_user_roles r
  WHERE p_firm_owner_id IS NULL AND r.role = 'admin';
$$;
REVOKE ALL ON FUNCTION public.inbox_staff_recipients(UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- RLS: read-only for the browser
-- -----------------------------------------------------------------------------
ALTER TABLE public.inbox_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Requester and staff read threads" ON public.inbox_threads;
CREATE POLICY "Requester and staff read threads"
ON public.inbox_threads FOR SELECT TO authenticated
USING (requester_id = auth.uid() OR public.inbox_is_staff_for(firm_owner_id));

DROP POLICY IF EXISTS "Requester and staff read messages" ON public.inbox_messages;
CREATE POLICY "Requester and staff read messages"
ON public.inbox_messages FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.inbox_threads t WHERE t.id = thread_id));

-- -----------------------------------------------------------------------------
-- Internal: append a message and update the thread + in-app notifications
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._inbox_append(
  p_thread_id UUID,
  p_author_id UUID,
  p_author_type TEXT,
  p_author_name TEXT,
  p_body TEXT,
  p_via_email BOOLEAN DEFAULT false
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_thread public.inbox_threads%ROWTYPE;
  v_message_id UUID;
  v_preview TEXT := left(regexp_replace(trim(p_body), '\s+', ' ', 'g'), 160);
BEGIN
  SELECT * INTO v_thread FROM public.inbox_threads WHERE id = p_thread_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  INSERT INTO public.inbox_messages (thread_id, author_id, author_type, author_name, body, via_email)
  VALUES (p_thread_id, p_author_id, p_author_type, coalesce(nullif(trim(p_author_name), ''), 'Unknown'), trim(p_body), p_via_email)
  RETURNING id INTO v_message_id;

  IF p_author_type = 'requester' THEN
    UPDATE public.inbox_threads
    SET staff_unread = true,
        requester_unread = false,
        status = CASE WHEN status = 'closed' OR status = 'pending' THEN 'open' ELSE status END,
        last_message_at = now(),
        last_message_preview = v_preview
    WHERE id = p_thread_id;

    -- Bell notification for everyone who answers this inbox.
    INSERT INTO public.notifications (user_id, recipient_id, title, message, notification_type, reference_id, reference_type)
    SELECT r.user_id, r.user_id,
           'New message from ' || v_thread.requester_name,
           v_thread.subject || ': ' || v_preview,
           'client_message', p_thread_id, 'inbox_thread'
    FROM public.inbox_staff_recipients(v_thread.firm_owner_id) r
    WHERE r.user_id IS DISTINCT FROM p_author_id;
  ELSE
    UPDATE public.inbox_threads
    SET requester_unread = true,
        staff_unread = false,
        status = CASE WHEN status = 'open' THEN 'pending' ELSE status END,
        last_message_at = now(),
        last_message_preview = v_preview
    WHERE id = p_thread_id;

    IF v_thread.requester_id IS NOT NULL AND v_thread.requester_id IS DISTINCT FROM p_author_id THEN
      INSERT INTO public.notifications (user_id, recipient_id, title, message, notification_type, reference_id, reference_type)
      VALUES (v_thread.requester_id, v_thread.requester_id,
              'New reply: ' || v_thread.subject, v_preview,
              'client_message', p_thread_id, 'inbox_thread');
    END IF;
  END IF;

  RETURN v_message_id;
END;
$$;
REVOKE ALL ON FUNCTION public._inbox_append(UUID, UUID, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Public API
-- -----------------------------------------------------------------------------

-- Start a conversation. Signed-in callers are identified from their session;
-- logged-out visitors must give a name and email (they cannot read it back).
-- Returns the new thread id and the first message id (for the email notice).
CREATE OR REPLACE FUNCTION public.inbox_start_thread(
  p_subject TEXT,
  p_body TEXT,
  p_source TEXT DEFAULT 'chat_widget',
  p_name TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL
)
RETURNS TABLE (thread_id UUID, message_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_name TEXT;
  v_email TEXT;
  v_firm UUID;
  v_thread UUID;
  v_message UUID;
BEGIN
  IF coalesce(trim(p_subject), '') = '' OR coalesce(trim(p_body), '') = '' THEN
    RAISE EXCEPTION 'Subject and message are required';
  END IF;
  IF length(p_subject) > 300 OR length(p_body) > 10000 THEN
    RAISE EXCEPTION 'Message is too long';
  END IF;

  IF v_uid IS NOT NULL THEN
    SELECT u.email,
           coalesce(nullif(trim(p.full_name), ''), nullif(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1))
    INTO v_email, v_name
    FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id
    WHERE u.id = v_uid;

    IF public.has_app_role(v_uid, 'client') THEN
      v_firm := public.inbox_firm_for_client(v_uid);
    END IF;
  ELSE
    v_name := trim(coalesce(p_name, ''));
    v_email := trim(coalesce(p_email, ''));
    IF v_name = '' OR v_email = '' THEN
      RAISE EXCEPTION 'Name and email are required';
    END IF;
    IF length(v_name) > 200 OR length(v_email) > 254 OR v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
      RAISE EXCEPTION 'Please enter a valid name and email address';
    END IF;
  END IF;

  INSERT INTO public.inbox_threads (firm_owner_id, requester_id, requester_name, requester_email, subject, source)
  VALUES (
    v_firm, v_uid, v_name, v_email, trim(p_subject),
    CASE WHEN p_source IN ('chat_widget', 'portal') THEN p_source ELSE 'chat_widget' END
  )
  RETURNING id INTO v_thread;

  v_message := public._inbox_append(v_thread, v_uid, 'requester', v_name, p_body);

  RETURN QUERY SELECT v_thread, v_message;
END;
$$;
REVOKE ALL ON FUNCTION public.inbox_start_thread(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inbox_start_thread(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- Reply in an existing conversation, as the requester or as staff.
CREATE OR REPLACE FUNCTION public.inbox_reply(p_thread_id UUID, p_body TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_thread public.inbox_threads%ROWTYPE;
  v_name TEXT;
  v_type TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in to reply';
  END IF;
  IF coalesce(trim(p_body), '') = '' THEN
    RAISE EXCEPTION 'Message is required';
  END IF;

  SELECT * INTO v_thread FROM public.inbox_threads WHERE id = p_thread_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  IF v_thread.requester_id = v_uid AND NOT public.inbox_is_staff_for(v_thread.firm_owner_id) THEN
    v_type := 'requester';
  ELSIF public.inbox_is_staff_for(v_thread.firm_owner_id) THEN
    v_type := 'staff';
  ELSIF v_thread.requester_id = v_uid THEN
    v_type := 'requester';
  ELSE
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  SELECT coalesce(nullif(trim(p.full_name), ''), nullif(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1))
  INTO v_name
  FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id
  WHERE u.id = v_uid;

  RETURN public._inbox_append(p_thread_id, v_uid, v_type, v_name, p_body);
END;
$$;
REVOKE ALL ON FUNCTION public.inbox_reply(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_reply(UUID, TEXT) TO authenticated;

-- Mark a conversation read for whichever side the caller is on.
CREATE OR REPLACE FUNCTION public.inbox_mark_read(p_thread_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_thread public.inbox_threads%ROWTYPE;
BEGIN
  SELECT * INTO v_thread FROM public.inbox_threads WHERE id = p_thread_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF public.inbox_is_staff_for(v_thread.firm_owner_id) THEN
    UPDATE public.inbox_threads SET staff_unread = false WHERE id = p_thread_id AND staff_unread;
  END IF;
  IF v_thread.requester_id = auth.uid() THEN
    UPDATE public.inbox_threads SET requester_unread = false WHERE id = p_thread_id AND requester_unread;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.inbox_mark_read(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_mark_read(UUID) TO authenticated;

-- Staff: change status (open / pending / closed) or mark unread again.
CREATE OR REPLACE FUNCTION public.inbox_update_thread(
  p_thread_id UUID,
  p_status TEXT DEFAULT NULL,
  p_staff_unread BOOLEAN DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_firm UUID;
BEGIN
  SELECT firm_owner_id INTO v_firm FROM public.inbox_threads WHERE id = p_thread_id;
  IF NOT FOUND OR NOT public.inbox_is_staff_for(v_firm) THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'pending', 'closed') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  UPDATE public.inbox_threads
  SET status = coalesce(p_status, status),
      staff_unread = coalesce(p_staff_unread, staff_unread)
  WHERE id = p_thread_id;
END;
$$;
REVOKE ALL ON FUNCTION public.inbox_update_thread(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_update_thread(UUID, TEXT, BOOLEAN) TO authenticated;

-- Server-side intake (contact form edge function, inbound email webhook).
-- Not callable from the browser.
CREATE OR REPLACE FUNCTION public.inbox_ingest(
  p_name TEXT,
  p_email TEXT,
  p_subject TEXT,
  p_body TEXT,
  p_source TEXT,
  p_ref_code TEXT DEFAULT NULL
)
RETURNS TABLE (thread_id UUID, message_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_thread public.inbox_threads%ROWTYPE;
  v_email TEXT := lower(trim(coalesce(p_email, '')));
  v_name TEXT := coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1));
  v_staff_id UUID;
  v_message UUID;
BEGIN
  IF v_email = '' OR coalesce(trim(p_body), '') = '' THEN
    RAISE EXCEPTION 'Sender and message are required';
  END IF;

  -- An email reply to an existing conversation: [MSG-XXXXXXXX] in the subject.
  IF p_ref_code IS NOT NULL THEN
    SELECT * INTO v_thread FROM public.inbox_threads WHERE ref_code = upper(p_ref_code);
    IF FOUND THEN
      IF lower(v_thread.requester_email) = v_email THEN
        v_message := public._inbox_append(v_thread.id, v_thread.requester_id, 'requester', v_name, p_body, true);
        RETURN QUERY SELECT v_thread.id, v_message;
        RETURN;
      END IF;

      -- A staff member replying by email from their own address.
      SELECT s.user_id INTO v_staff_id
      FROM public.inbox_staff_recipients(v_thread.firm_owner_id) s
      JOIN auth.users u ON u.id = s.user_id
      WHERE lower(u.email) = v_email
      LIMIT 1;
      IF v_staff_id IS NOT NULL THEN
        v_message := public._inbox_append(v_thread.id, v_staff_id, 'staff', v_name, p_body, true);
        RETURN QUERY SELECT v_thread.id, v_message;
        RETURN;
      END IF;
      -- Unknown sender: fall through and open a new conversation.
    END IF;
  END IF;

  INSERT INTO public.inbox_threads (firm_owner_id, requester_id, requester_name, requester_email, subject, source)
  VALUES (
    NULL,
    (SELECT id FROM auth.users WHERE lower(email) = v_email LIMIT 1),
    left(v_name, 200), left(v_email, 254),
    left(coalesce(nullif(trim(p_subject), ''), '(no subject)'), 300),
    CASE WHEN p_source IN ('contact_form', 'email') THEN p_source ELSE 'email' END
  )
  RETURNING * INTO v_thread;

  -- A known client's email goes to their firm rather than MAJRBooks support.
  IF v_thread.requester_id IS NOT NULL AND public.has_app_role(v_thread.requester_id, 'client') THEN
    UPDATE public.inbox_threads
    SET firm_owner_id = public.inbox_firm_for_client(v_thread.requester_id)
    WHERE id = v_thread.id;
  END IF;

  v_message := public._inbox_append(v_thread.id, v_thread.requester_id, 'requester', v_name, left(p_body, 10000), p_source = 'email');
  RETURN QUERY SELECT v_thread.id, v_message;
END;
$$;
REVOKE ALL ON FUNCTION public.inbox_ingest(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_ingest(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- Help-center tickets (create_support_ticket) also land in the inbox.
CREATE OR REPLACE FUNCTION public.support_ticket_to_inbox()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.inbox_ingest(
    NEW.name, NEW.email,
    '[' || NEW.ticket_number || '] ' || NEW.subject,
    NEW.message || E'\n\n— Category: ' || NEW.category || ' · Priority: ' || NEW.priority,
    'contact_form'
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block ticket creation because of the inbox copy.
  RAISE WARNING 'support_ticket_to_inbox failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS support_ticket_to_inbox ON public.support_tickets;
CREATE TRIGGER support_ticket_to_inbox
  AFTER INSERT ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.support_ticket_to_inbox();

-- Live updates in the inbox and the chat widget.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox_threads;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox_messages;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
