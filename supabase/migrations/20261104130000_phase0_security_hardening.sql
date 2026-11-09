-- =============================================================================
-- Phase 0 — security & data-integrity hardening
--
-- Fixes (see docs/AUDIT-2026-11-04.md §6):
--   1. Invited clients get the `client` app role again (regressed in
--      20260226155834), and existing invited clients are backfilled.
--   2. invoice_payments can only be recorded against the caller's own invoices.
--   3. support_tickets: anonymous tickets are no longer world-readable and
--      tickets cannot be forged under another user's id.
--   4. Invite RPCs no longer bind an arbitrary user id to an invitation.
--   5. accrue_pto_for_payroll trusts auth.uid(), not a caller-supplied id.
--   6. profiles.trial_ends_at can no longer be changed by the user; a one-time
--      start_free_trial() RPC replaces the client-side writes.
--   7. notifications can only be addressed to people in the sender's firm.
--   8. Only admins may upload to the public `assets` bucket.
--
-- Every statement is idempotent so it can be re-run safely.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. App role assignment on signup (+ backfill)
-- -----------------------------------------------------------------------------
-- `client` is granted only when the signup is flagged is_client AND a live
-- invitation exists for that email address, so the flag alone cannot be
-- used to pick a role.
CREATE OR REPLACE FUNCTION public.handle_new_user_app_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_is_client BOOLEAN := COALESCE((NEW.raw_user_meta_data->>'is_client')::boolean, false);
BEGIN
  IF lower(NEW.email) IN ('support@prm3tax.com', 'support@majrtaxsoftware.com', 'asimmons@prm3tax.com') THEN
    INSERT INTO public.app_user_roles (user_id, role)
    VALUES (NEW.id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  ELSIF v_is_client AND EXISTS (
    SELECT 1
    FROM public.client_invitations ci
    WHERE lower(ci.client_email) = lower(NEW.email)
      AND ci.status = 'pending'
      AND (ci.expires_at IS NULL OR ci.expires_at > now())
  ) THEN
    INSERT INTO public.app_user_roles (user_id, role)
    VALUES (NEW.id, 'client')
    ON CONFLICT (user_id, role) DO NOTHING;
  ELSE
    INSERT INTO public.app_user_roles (user_id, role)
    VALUES (NEW.id, 'user')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

-- Backfill: accounts that accepted a client invitation, signed up through the
-- client flow, and were wrongly given `user` since 2026-02-26.
WITH invited AS (
  SELECT DISTINCT ci.client_user_id AS user_id
  FROM public.client_invitations ci
  JOIN auth.users u ON u.id = ci.client_user_id
  WHERE ci.client_user_id IS NOT NULL
    AND COALESCE((u.raw_user_meta_data->>'is_client')::boolean, false)
    AND NOT EXISTS (
      SELECT 1 FROM public.app_user_roles r
      WHERE r.user_id = ci.client_user_id AND r.role = 'admin'
    )
),
removed AS (
  DELETE FROM public.app_user_roles r
  USING invited i
  WHERE r.user_id = i.user_id AND r.role = 'user'
  RETURNING r.user_id
)
INSERT INTO public.app_user_roles (user_id, role)
SELECT user_id, 'client' FROM invited
ON CONFLICT (user_id, role) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 2. invoice_payments: caller must own the invoice
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can create own payments" ON public.invoice_payments;
CREATE POLICY "Users can create own payments"
ON public.invoice_payments
FOR INSERT
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_id AND i.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "Users can update own payments" ON public.invoice_payments;
CREATE POLICY "Users can update own payments"
ON public.invoice_payments
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_id AND i.user_id = auth.uid()
  )
);

-- Defense in depth: payment_journal_entry_trigger is SECURITY DEFINER and
-- updates the invoice, so also enforce ownership and a positive amount in a
-- trigger that runs first (triggers fire in name order; "a_" sorts first).
CREATE OR REPLACE FUNCTION public.enforce_invoice_payment_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = NEW.invoice_id AND i.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_enforce_invoice_payment_integrity ON public.invoice_payments;
CREATE TRIGGER a_enforce_invoice_payment_integrity
BEFORE INSERT OR UPDATE ON public.invoice_payments
FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_payment_integrity();


-- -----------------------------------------------------------------------------
-- 3. support_tickets
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own tickets" ON public.support_tickets;
CREATE POLICY "Users can view own tickets"
ON public.support_tickets
FOR SELECT
USING (
  (auth.uid() IS NOT NULL AND auth.uid() = user_id)
  OR public.has_app_role(auth.uid(), 'admin')
);

DROP POLICY IF EXISTS "Anyone can create tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Users can create own tickets" ON public.support_tickets;
CREATE POLICY "Users can create own tickets"
ON public.support_tickets
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- Logged-out visitors submit through this function, which returns only the
-- new ticket number (they cannot read tickets back).
CREATE OR REPLACE FUNCTION public.create_support_ticket(
  p_name TEXT,
  p_email TEXT,
  p_category TEXT,
  p_priority TEXT,
  p_subject TEXT,
  p_message TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_number TEXT;
BEGIN
  IF coalesce(trim(p_name), '') = '' OR coalesce(trim(p_email), '') = ''
     OR coalesce(trim(p_subject), '') = '' OR coalesce(trim(p_message), '') = '' THEN
    RAISE EXCEPTION 'Name, email, subject and message are required';
  END IF;
  IF length(p_name) > 200 OR length(p_email) > 254 OR length(p_subject) > 300
     OR length(p_message) > 10000 OR length(coalesce(p_category, '')) > 100 THEN
    RAISE EXCEPTION 'Ticket fields are too long';
  END IF;
  IF p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Please enter a valid email address';
  END IF;

  INSERT INTO public.support_tickets (user_id, name, email, category, priority, subject, message, ticket_number)
  VALUES (
    auth.uid(),
    trim(p_name),
    trim(p_email),
    coalesce(nullif(trim(p_category), ''), 'general'),
    CASE WHEN p_priority IN ('low', 'medium', 'high', 'urgent') THEN p_priority ELSE 'medium' END,
    trim(p_subject),
    p_message,
    'TEMP'
  )
  RETURNING ticket_number INTO v_ticket_number;

  RETURN v_ticket_number;
END;
$$;

REVOKE ALL ON FUNCTION public.create_support_ticket(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_support_ticket(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;


-- -----------------------------------------------------------------------------
-- 4. Invite RPCs: bind only the account that was actually created for the
--    invited email address.
--
--    When the caller is signed in, p_user_id must be the caller. When there
--    is no session yet (email confirmation pending), the account must be the
--    one just created (< 1 hour old) with the invited email address.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_team_invite(p_token TEXT, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member public.team_members%ROWTYPE;
  v_email TEXT;
  v_created_at TIMESTAMPTZ;
BEGIN
  IF p_token IS NULL OR p_user_id IS NULL THEN
    RETURN FALSE;
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_member
  FROM public.team_members
  WHERE invite_token = p_token
    AND invite_accepted_at IS NULL
    AND user_id IS NULL
    AND invite_sent_at > (now() - interval '7 days')
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  SELECT u.email, u.created_at INTO v_email, v_created_at
  FROM auth.users u WHERE u.id = p_user_id;
  IF NOT FOUND OR lower(v_email) <> lower(v_member.email) THEN
    RETURN FALSE;
  END IF;
  IF auth.uid() IS NULL AND v_created_at < now() - interval '1 hour' THEN
    RETURN FALSE;
  END IF;

  UPDATE public.team_members
  SET user_id = p_user_id,
      invite_accepted_at = now(),
      is_active = true,
      updated_at = now()
  WHERE id = v_member.id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_team_invite(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_team_invite(TEXT, UUID) TO anon, authenticated;

-- Also creates the firm's `clients` record for the new portal user. This used
-- to be a direct insert from the browser into another firm's rows.
CREATE OR REPLACE FUNCTION public.mark_invitation_used(p_token TEXT, p_client_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.client_invitations%ROWTYPE;
  v_email TEXT;
  v_created_at TIMESTAMPTZ;
  v_meta JSONB;
BEGIN
  IF p_token IS NULL OR p_client_user_id IS NULL THEN
    RETURN FALSE;
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_client_user_id THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_inv
  FROM public.client_invitations
  WHERE invite_token = p_token
    AND used_at IS NULL
    AND status = 'pending'
    AND (expires_at IS NULL OR expires_at > now())
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  SELECT u.email, u.created_at, u.raw_user_meta_data INTO v_email, v_created_at, v_meta
  FROM auth.users u WHERE u.id = p_client_user_id;
  IF NOT FOUND OR lower(v_email) <> lower(v_inv.client_email) THEN
    RETURN FALSE;
  END IF;
  IF auth.uid() IS NULL AND v_created_at < now() - interval '1 hour' THEN
    RETURN FALSE;
  END IF;

  UPDATE public.client_invitations
  SET used_at = now(),
      client_user_id = p_client_user_id,
      status = 'accepted',
      responded_at = now(),
      updated_at = now()
  WHERE id = v_inv.id;

  -- Make sure the portal user has the client role (in case the signup trigger
  -- ran without seeing the invitation).
  IF NOT EXISTS (SELECT 1 FROM public.app_user_roles WHERE user_id = p_client_user_id AND role = 'admin') THEN
    DELETE FROM public.app_user_roles WHERE user_id = p_client_user_id AND role = 'user';
    INSERT INTO public.app_user_roles (user_id, role)
    VALUES (p_client_user_id, 'client')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;

  -- Create the firm's CRM record for this client if it does not exist yet.
  IF NOT EXISTS (
    SELECT 1 FROM public.clients c
    WHERE c.user_id = v_inv.firm_id AND lower(c.email) = lower(v_email)
  ) THEN
    INSERT INTO public.clients (user_id, client_name, email, phone, status, notes)
    VALUES (
      v_inv.firm_id,
      coalesce(nullif(v_meta->>'full_name', ''), v_inv.client_name),
      v_email,
      nullif(v_meta->>'phone', ''),
      'active',
      format('Client portal user ID: %s. Firm: %s', p_client_user_id, coalesce(v_inv.inviter_business_name, 'MAJR Books'))
    );
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_invitation_used(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_invitation_used(TEXT, UUID) TO anon, authenticated;


-- -----------------------------------------------------------------------------
-- 5. accrue_pto_for_payroll: use the caller's identity
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accrue_pto_for_payroll(
  p_employee_id UUID,
  p_user_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- p_user_id is kept for signature compatibility but must be the caller.
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE pto_balances
  SET
    balance_hours = LEAST(
      balance_hours + accrual_rate,
      COALESCE(max_balance, balance_hours + accrual_rate)
    ),
    accrued_hours = accrued_hours + accrual_rate,
    updated_at = now()
  WHERE employee_id = p_employee_id
    AND EXISTS (
      SELECT 1 FROM employees
      WHERE employees.id = p_employee_id
        AND employees.user_id = auth.uid()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.accrue_pto_for_payroll(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accrue_pto_for_payroll(UUID, UUID) TO authenticated;


-- -----------------------------------------------------------------------------
-- 6. Trial: users cannot set their own trial_ends_at
-- -----------------------------------------------------------------------------
-- Direct writes from the API roles keep the stored value. SECURITY DEFINER
-- functions (signup trigger, start_free_trial) run as the function owner and
-- are unaffected.
CREATE OR REPLACE FUNCTION public.protect_profile_billing_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.trial_ends_at := OLD.trial_ends_at;
    ELSIF TG_OP = 'INSERT' THEN
      NEW.trial_ends_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_billing_fields ON public.profiles;
CREATE TRIGGER protect_profile_billing_fields
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.protect_profile_billing_fields();

-- One-time trial for an account owner that never had one (e.g. accounts
-- created before the signup trigger granted trials). Never extends a trial.
CREATE OR REPLACE FUNCTION public.start_free_trial()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_current TIMESTAMPTZ;
  v_meta JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT raw_user_meta_data INTO v_meta FROM auth.users WHERE id = v_uid;
  IF COALESCE((v_meta->>'is_client')::boolean, false)
     OR COALESCE((v_meta->>'is_team_member')::boolean, false) THEN
    RAISE EXCEPTION 'Invited accounts are covered by their firm''s subscription';
  END IF;

  SELECT trial_ends_at INTO v_current FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF v_current IS NOT NULL THEN
    -- Already had a trial: return it unchanged (may be in the past).
    RETURN v_current;
  END IF;

  UPDATE public.profiles
  SET trial_ends_at = now() + interval '14 days'
  WHERE id = v_uid
  RETURNING trial_ends_at INTO v_current;

  RETURN v_current;
END;
$$;

REVOKE ALL ON FUNCTION public.start_free_trial() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_free_trial() TO authenticated;


-- -----------------------------------------------------------------------------
-- 7. notifications: recipient must be in the sender's firm
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can create notifications" ON public.notifications;
CREATE POLICY "Users can create notifications"
ON public.notifications
FOR INSERT
WITH CHECK (
  auth.uid() = user_id
  AND (
    recipient_id IS NULL
    OR recipient_id = auth.uid()
    -- my team members
    OR EXISTS (SELECT 1 FROM public.team_members tm
               WHERE tm.owner_id = auth.uid() AND tm.user_id = recipient_id)
    -- my firm owner, or a colleague in the same firm
    OR EXISTS (SELECT 1 FROM public.team_members me
               WHERE me.user_id = auth.uid() AND me.is_active
                 AND (me.owner_id = recipient_id
                      OR EXISTS (SELECT 1 FROM public.team_members peer
                                 WHERE peer.owner_id = me.owner_id AND peer.user_id = recipient_id)))
    -- my portal clients
    OR EXISTS (SELECT 1 FROM public.client_invitations ci
               WHERE ci.user_id = auth.uid() AND ci.client_user_id = recipient_id)
  )
);


-- -----------------------------------------------------------------------------
-- 8. Public assets bucket: admin uploads only
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can upload assets" ON storage.objects;
DROP POLICY IF EXISTS "Admins can upload assets" ON storage.objects;
CREATE POLICY "Admins can upload assets"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'assets' AND public.has_app_role(auth.uid(), 'admin'));
