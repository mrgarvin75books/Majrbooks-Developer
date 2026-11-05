-- =============================================================================
-- Phase 2 (blueprint) — part 1: the business is the data boundary
--
-- * businesses: one set of books. Every account owner gets a default
--   business ("Your Books"); client businesses are added in Phase 6.
-- * business_members: who can access which business, with what role.
-- * Ledger tables (chart_of_accounts, journal_entries, journal_entry_lines)
--   gain business_id, are backfilled, and their RLS moves from "my user id"
--   to "a business I am a member of". Team members therefore gain access to
--   their owner's books at the database level.
--
-- Module tables (invoices, bills, bank_transactions, ...) get business_id in
-- their own phases (3 and 4).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  client_id UUID UNIQUE REFERENCES public.clients(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  legal_name TEXT,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),  -- multi-currency is out of scope for v1
  accounting_method TEXT NOT NULL DEFAULT 'accrual' CHECK (accounting_method IN ('accrual', 'cash')),
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  books_start_date DATE,
  lock_date DATE,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

-- One default ("Your Books") business per owner.
CREATE UNIQUE INDEX IF NOT EXISTS businesses_one_default_per_owner
  ON public.businesses (owner_user_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS public.business_members (
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- owner: the paying account owner · admin/accountant: firm staff with full
  -- bookkeeping rights · staff: view-only employee · client: portal user
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'accountant', 'staff', 'client')),
  is_lead_accountant BOOLEAN NOT NULL DEFAULT false,
  client_toggles JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX IF NOT EXISTS business_members_user_idx ON public.business_members (user_id);

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_members ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_businesses_updated_at ON public.businesses;
CREATE TRIGGER update_businesses_updated_at
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- -----------------------------------------------------------------------------
-- Membership helpers (SECURITY DEFINER to avoid RLS recursion; always about
-- the *calling* user, so they leak nothing about other users)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_role(p_business_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT role FROM public.business_members
  WHERE business_id = p_business_id AND user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_business_member(p_business_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.business_members
    WHERE business_id = p_business_id AND user_id = auth.uid()
  );
$$;

-- Owners, firm admins and accountants may keep the books.
CREATE OR REPLACE FUNCTION public.can_keep_books(p_business_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.business_members
    WHERE business_id = p_business_id AND user_id = auth.uid()
      AND role IN ('owner', 'admin', 'accountant')
  );
$$;

REVOKE ALL ON FUNCTION public.business_role(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_business_member(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_keep_books(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.business_role(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_business_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_keep_books(UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- RLS for the new tables
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Members can view their businesses" ON public.businesses;
CREATE POLICY "Members can view their businesses"
  ON public.businesses FOR SELECT
  USING (public.is_business_member(id));

-- Settings (name, method, fiscal year) — owner/admin only. The lock date is
-- changed only through set_lock_date() so every change is logged.
DROP POLICY IF EXISTS "Owners can update their businesses" ON public.businesses;
CREATE POLICY "Owners can update their businesses"
  ON public.businesses FOR UPDATE
  USING (public.business_role(id) IN ('owner', 'admin'))
  WITH CHECK (public.business_role(id) IN ('owner', 'admin'));

DROP POLICY IF EXISTS "Members can view co-members" ON public.business_members;
CREATE POLICY "Members can view co-members"
  ON public.business_members FOR SELECT
  USING (public.is_business_member(business_id));

-- Protected business columns: only SECURITY DEFINER code may change them.
CREATE OR REPLACE FUNCTION public.protect_business_columns()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.owner_user_id := OLD.owner_user_id;
    NEW.client_id := OLD.client_id;
    NEW.is_default := OLD.is_default;
    NEW.lock_date := OLD.lock_date;
    NEW.currency := OLD.currency;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_business_columns ON public.businesses;
CREATE TRIGGER protect_business_columns
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.protect_business_columns();

-- -----------------------------------------------------------------------------
-- Default business resolution
-- -----------------------------------------------------------------------------
-- The business a user works in when no business is named explicitly:
-- their own default business, else (team member) their owner's.
CREATE OR REPLACE FUNCTION public.default_business_id(p_user_id UUID)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT b.id FROM public.businesses b
      WHERE b.owner_user_id = p_user_id AND b.is_default AND b.archived_at IS NULL),
    (SELECT b.id FROM public.team_members tm
       JOIN public.businesses b ON b.owner_user_id = tm.owner_id AND b.is_default
      WHERE tm.user_id = p_user_id AND tm.is_active
      ORDER BY tm.created_at LIMIT 1)
  );
$$;
REVOKE ALL ON FUNCTION public.default_business_id(UUID) FROM PUBLIC, anon, authenticated;

-- Creates the owner's default business on first use. Invited clients never
-- get one (they work inside their firm's books).
CREATE OR REPLACE FUNCTION public.ensure_default_business(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id UUID := public.default_business_id(p_user_id);
  v_name TEXT;
BEGIN
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_user_roles WHERE user_id = p_user_id AND role = 'client') THEN
    RAISE EXCEPTION 'NO_BUSINESS: client accounts do not have their own books';
  END IF;

  SELECT COALESCE(NULLIF(trim(p.business_name), ''), NULLIF(trim(p.full_name), ''), 'My Business')
    INTO v_name FROM public.profiles p WHERE p.id = p_user_id;

  INSERT INTO public.businesses (owner_user_id, name, is_default)
  VALUES (p_user_id, COALESCE(v_name, 'My Business'), true)
  ON CONFLICT (owner_user_id) WHERE is_default DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN  -- created concurrently
    v_id := public.default_business_id(p_user_id);
  END IF;

  INSERT INTO public.business_members (business_id, user_id, role)
  VALUES (v_id, p_user_id, 'owner')
  ON CONFLICT DO NOTHING;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_default_business(UUID) FROM PUBLIC, anon, authenticated;

-- The business the signed-in user is working in (frontend entry point until
-- the Phase 1 business switcher exists).
CREATE OR REPLACE FUNCTION public.current_business()
RETURNS TABLE (business_id UUID, name TEXT, role TEXT, lock_date DATE, accounting_method TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_id := public.default_business_id(auth.uid());
  IF v_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.app_user_roles ar WHERE ar.user_id = auth.uid() AND ar.role = 'client'
  ) THEN
    v_id := public.ensure_default_business(auth.uid());
  END IF;
  RETURN QUERY
    SELECT b.id, b.name, m.role, b.lock_date, b.accounting_method
    FROM public.businesses b
    JOIN public.business_members m ON m.business_id = b.id AND m.user_id = auth.uid()
    WHERE b.id = v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.current_business() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_business() TO authenticated;

-- -----------------------------------------------------------------------------
-- Keep team-member access in sync with team_members
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_team_member_business_access()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_business UUID;
  v_role TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.user_id IS NOT NULL THEN
    DELETE FROM public.business_members m
    USING public.businesses b
    WHERE m.business_id = b.id AND b.owner_user_id = OLD.owner_id
      AND m.user_id = OLD.user_id AND m.role <> 'owner';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.user_id IS NOT NULL AND NEW.is_active THEN
    v_business := public.ensure_default_business(NEW.owner_id);
    v_role := CASE NEW.role::text
                WHEN 'admin' THEN 'admin'
                WHEN 'accountant' THEN 'accountant'
                ELSE 'staff'
              END;
    INSERT INTO public.business_members (business_id, user_id, role)
    VALUES (v_business, NEW.user_id, v_role)
    ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role
      WHERE public.business_members.role <> 'owner';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS sync_team_member_business_access ON public.team_members;
CREATE TRIGGER sync_team_member_business_access
  AFTER INSERT OR UPDATE OF user_id, is_active, role OR DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.sync_team_member_business_access();

-- -----------------------------------------------------------------------------
-- business_id on the ledger tables
-- -----------------------------------------------------------------------------
ALTER TABLE public.chart_of_accounts   ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id);
ALTER TABLE public.journal_entries     ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id);
ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id);

-- Backfill: a default business for every owner who has ledger data or is a
-- non-client account; then memberships for active team members.
DO $$
BEGIN
  -- Anyone who already has ledger data owns those books (even if they are now
  -- a client or team member); every other non-client, non-team account gets
  -- an empty default business.
  INSERT INTO public.businesses (owner_user_id, name, is_default)
  SELECT u.user_id,
         COALESCE(NULLIF(trim(p.business_name), ''), NULLIF(trim(p.full_name), ''), 'My Business'),
         true
  FROM (
    SELECT user_id FROM public.chart_of_accounts
    UNION SELECT user_id FROM public.journal_entries
    UNION SELECT user_id FROM public.invoices
    UNION SELECT p2.id FROM public.profiles p2
      WHERE NOT EXISTS (SELECT 1 FROM public.app_user_roles ar WHERE ar.user_id = p2.id AND ar.role = 'client')
        AND NOT EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.user_id = p2.id AND tm.is_active)
  ) u
  JOIN auth.users au ON au.id = u.user_id
  LEFT JOIN public.profiles p ON p.id = u.user_id
  ON CONFLICT (owner_user_id) WHERE is_default DO NOTHING;

  INSERT INTO public.business_members (business_id, user_id, role)
  SELECT b.id, b.owner_user_id, 'owner' FROM public.businesses b
  ON CONFLICT DO NOTHING;

  INSERT INTO public.business_members (business_id, user_id, role)
  SELECT b.id, tm.user_id,
         CASE tm.role::text WHEN 'admin' THEN 'admin' WHEN 'accountant' THEN 'accountant' ELSE 'staff' END
  FROM public.team_members tm
  JOIN public.businesses b ON b.owner_user_id = tm.owner_id AND b.is_default
  WHERE tm.user_id IS NOT NULL AND tm.is_active
  ON CONFLICT DO NOTHING;
END $$;

UPDATE public.chart_of_accounts a SET business_id = b.id
FROM public.businesses b
WHERE a.business_id IS NULL AND b.owner_user_id = a.user_id AND b.is_default;

UPDATE public.journal_entries e SET business_id = b.id
FROM public.businesses b
WHERE e.business_id IS NULL AND b.owner_user_id = e.user_id AND b.is_default;

UPDATE public.journal_entry_lines l SET business_id = e.business_id
FROM public.journal_entries e
WHERE l.business_id IS NULL AND l.journal_entry_id = e.id;

-- Fill business_id on new rows from the row's user (keeps existing screens,
-- which only send user_id, working until the business switcher ships).
CREATE OR REPLACE FUNCTION public.fill_business_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.business_id IS NULL THEN
    IF TG_TABLE_NAME = 'journal_entry_lines' THEN
      SELECT business_id INTO NEW.business_id FROM public.journal_entries WHERE id = NEW.journal_entry_id;
    ELSE
      NEW.business_id := public.ensure_default_business(NEW.user_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_fill_business_id ON public.chart_of_accounts;
CREATE TRIGGER a_fill_business_id BEFORE INSERT ON public.chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION public.fill_business_id();
DROP TRIGGER IF EXISTS a_fill_business_id ON public.journal_entries;
CREATE TRIGGER a_fill_business_id BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.fill_business_id();
DROP TRIGGER IF EXISTS a_fill_business_id ON public.journal_entry_lines;
CREATE TRIGGER a_fill_business_id BEFORE INSERT ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.fill_business_id();

-- Required for every new row. NOT VALID so rows left over from deleted user
-- accounts (which cannot be given a business) do not block the migration;
-- such rows were already invisible and stay so. Run
--   SELECT count(*) FROM chart_of_accounts WHERE business_id IS NULL;
-- (and the same for journal_entries) to see whether any exist.
ALTER TABLE public.chart_of_accounts   DROP CONSTRAINT IF EXISTS chart_of_accounts_business_required;
ALTER TABLE public.chart_of_accounts   ADD CONSTRAINT chart_of_accounts_business_required CHECK (business_id IS NOT NULL) NOT VALID;
ALTER TABLE public.journal_entries     DROP CONSTRAINT IF EXISTS journal_entries_business_required;
ALTER TABLE public.journal_entries     ADD CONSTRAINT journal_entries_business_required CHECK (business_id IS NOT NULL) NOT VALID;
ALTER TABLE public.journal_entry_lines DROP CONSTRAINT IF EXISTS journal_entry_lines_business_required;
ALTER TABLE public.journal_entry_lines ADD CONSTRAINT journal_entry_lines_business_required CHECK (business_id IS NOT NULL) NOT VALID;

CREATE INDEX IF NOT EXISTS chart_of_accounts_business_idx ON public.chart_of_accounts (business_id);
CREATE INDEX IF NOT EXISTS journal_entries_business_date_idx ON public.journal_entries (business_id, entry_date);
CREATE INDEX IF NOT EXISTS journal_entry_lines_business_account_idx ON public.journal_entry_lines (business_id, account_id);
CREATE INDEX IF NOT EXISTS journal_entry_lines_entry_idx ON public.journal_entry_lines (journal_entry_id);

-- -----------------------------------------------------------------------------
-- RLS: membership-based. Journal tables are read-only through the API —
-- every write goes through the posting functions (next migration).
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own accounts" ON public.chart_of_accounts;
DROP POLICY IF EXISTS "Users can create own accounts" ON public.chart_of_accounts;
DROP POLICY IF EXISTS "Users can update own accounts" ON public.chart_of_accounts;
DROP POLICY IF EXISTS "Users can delete own accounts" ON public.chart_of_accounts;
DROP POLICY IF EXISTS "Members can view accounts" ON public.chart_of_accounts;
DROP POLICY IF EXISTS "Bookkeepers can create accounts" ON public.chart_of_accounts;
DROP POLICY IF EXISTS "Bookkeepers can update accounts" ON public.chart_of_accounts;
DROP POLICY IF EXISTS "Bookkeepers can delete accounts" ON public.chart_of_accounts;

CREATE POLICY "Members can view accounts" ON public.chart_of_accounts
  FOR SELECT USING (public.is_business_member(business_id));
CREATE POLICY "Bookkeepers can create accounts" ON public.chart_of_accounts
  FOR INSERT WITH CHECK (public.can_keep_books(business_id));
CREATE POLICY "Bookkeepers can update accounts" ON public.chart_of_accounts
  FOR UPDATE USING (public.can_keep_books(business_id)) WITH CHECK (public.can_keep_books(business_id));
CREATE POLICY "Bookkeepers can delete accounts" ON public.chart_of_accounts
  FOR DELETE USING (public.can_keep_books(business_id));

DROP POLICY IF EXISTS "Users can view own journal entries" ON public.journal_entries;
DROP POLICY IF EXISTS "Users can create own journal entries" ON public.journal_entries;
DROP POLICY IF EXISTS "Users can update own journal entries" ON public.journal_entries;
DROP POLICY IF EXISTS "Users can delete own journal entries" ON public.journal_entries;
DROP POLICY IF EXISTS "Members can view journal entries" ON public.journal_entries;
CREATE POLICY "Members can view journal entries" ON public.journal_entries
  FOR SELECT USING (public.is_business_member(business_id));

DROP POLICY IF EXISTS "Users can view own journal entry lines" ON public.journal_entry_lines;
DROP POLICY IF EXISTS "Users can create own journal entry lines" ON public.journal_entry_lines;
DROP POLICY IF EXISTS "Users can update own journal entry lines" ON public.journal_entry_lines;
DROP POLICY IF EXISTS "Users can delete own journal entry lines" ON public.journal_entry_lines;
DROP POLICY IF EXISTS "Members can view journal entry lines" ON public.journal_entry_lines;
CREATE POLICY "Members can view journal entry lines" ON public.journal_entry_lines
  FOR SELECT USING (public.is_business_member(business_id));

-- Audit trail: attach events to a business.
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id);
CREATE INDEX IF NOT EXISTS audit_logs_business_idx ON public.audit_logs (business_id, created_at DESC);
