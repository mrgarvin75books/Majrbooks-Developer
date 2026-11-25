-- =============================================================================
-- Transactional email notifications (Resend)
--
--   email_templates        admin overrides for the built-in templates
--                          (subject/body/CTA text and an on/off switch).
--                          Defaults live in supabase/functions/_shared/email.
--   email_logs             one row per delivery attempt. Never stores links,
--                          tokens or passwords: only the recipient, subject,
--                          status, Resend id, a scrubbed error and non-secret
--                          references (ids) used to resend.
--   password_reset_tokens  single-use, time-limited reset tokens. Only a
--                          SHA-256 hash of each token is stored.
--
-- Every table is readable by platform admins only and writable only by the
-- service role (edge functions). Idempotent so it can be re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.email_templates (
  template_key   TEXT PRIMARY KEY,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  subject        TEXT,
  preheader      TEXT,
  heading        TEXT,
  body           TEXT,
  secondary_body TEXT,
  cta_label      TEXT,
  updated_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key      TEXT NOT NULL,
  recipient_email   TEXT NOT NULL,
  recipient_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  subject           TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  resend_id         TEXT,
  error_message     TEXT,
  dedupe_key        TEXT,
  context           JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts          INTEGER NOT NULL DEFAULT 0,
  triggered_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resent_from       UUID REFERENCES public.email_logs(id) ON DELETE SET NULL,
  superseded_by     UUID REFERENCES public.email_logs(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON public.email_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON public.email_logs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_template ON public.email_logs (template_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_dedupe ON public.email_logs (dedupe_key, created_at DESC)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL UNIQUE,
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  requested_ip_hash TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON public.password_reset_tokens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_ip ON public.password_reset_tokens (requested_ip_hash, created_at DESC);

ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view email templates" ON public.email_templates;
CREATE POLICY "Admins can view email templates"
ON public.email_templates FOR SELECT
USING (public.has_app_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can view email logs" ON public.email_logs;
CREATE POLICY "Admins can view email logs"
ON public.email_logs FOR SELECT
USING (public.has_app_role(auth.uid(), 'admin'));

-- password_reset_tokens: no policies at all. Only the service role reads it.


-- -----------------------------------------------------------------------------
-- claim_email_send: atomically decide whether an email may be sent and, if so,
-- create its log row. Returns NULL when an identical email (same dedupe key)
-- is already sent or in flight inside the window, which is how duplicate
-- emails (double clicks, retries, concurrent calls) are suppressed.
--   p_window_seconds NULL  -> dedupe forever (e.g. one welcome email per account)
-- A 'pending' row older than 10 minutes is treated as abandoned.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_email_send(
  p_template_key TEXT,
  p_recipient_email TEXT,
  p_recipient_user_id UUID,
  p_subject TEXT,
  p_dedupe_key TEXT,
  p_window_seconds INTEGER,
  p_context JSONB,
  p_triggered_by UUID,
  p_resent_from UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_dedupe_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('email:' || p_dedupe_key, 0));

    IF EXISTS (
      SELECT 1 FROM public.email_logs l
      WHERE l.dedupe_key = p_dedupe_key
        AND (
          l.status = 'sent'
          OR (l.status = 'pending' AND l.created_at > now() - interval '10 minutes')
        )
        AND (p_window_seconds IS NULL OR l.created_at > now() - make_interval(secs => p_window_seconds))
    ) THEN
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO public.email_logs (
    template_key, recipient_email, recipient_user_id, subject, status,
    dedupe_key, context, triggered_by, resent_from
  ) VALUES (
    p_template_key, lower(p_recipient_email), p_recipient_user_id, p_subject, 'pending',
    p_dedupe_key, COALESCE(p_context, '{}'::jsonb), p_triggered_by, p_resent_from
  )
  RETURNING id INTO v_id;

  IF p_resent_from IS NOT NULL THEN
    UPDATE public.email_logs SET superseded_by = v_id, updated_at = now() WHERE id = p_resent_from;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_email_send(TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, JSONB, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_email_send(TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, JSONB, UUID, UUID) TO service_role;


-- -----------------------------------------------------------------------------
-- find_auth_user_id_by_email: lets the password-reset function look an account
-- up by address without paging through the whole user list. Service role only,
-- so it cannot be used to probe which emails are registered.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_auth_user_id_by_email(p_email TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT u.id FROM auth.users u
  WHERE lower(u.email) = lower(trim(p_email))
    AND u.deleted_at IS NULL
  ORDER BY u.created_at
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.find_auth_user_id_by_email(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_auth_user_id_by_email(TEXT) TO service_role;


-- -----------------------------------------------------------------------------
-- revoke_user_sessions: after a password reset, sign the account out on every
-- device (refresh tokens are removed with their sessions). Service role only.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  DELETE FROM auth.sessions WHERE user_id = p_user_id
$$;

REVOKE ALL ON FUNCTION public.revoke_user_sessions(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(UUID) TO service_role;
