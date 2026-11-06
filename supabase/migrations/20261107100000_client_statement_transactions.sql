-- =============================================================================
-- Client bank-statement transactions (imported from Excel / CSV)
--
-- Each client's statement lines live in their own table, separate from the
-- firm's own books (`transactions`, `journal_entries`), so importing a
-- client's statement never changes the firm's reports. When client
-- businesses get their own ledgers (blueprint Phase 6) these lines become
-- the bank review queue for that business.
--
-- Self-contained: depends only on public.clients and public.team_members,
-- so it can be applied on its own (e.g. pasted into the Supabase SQL editor).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.client_statement_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),          -- firm owner (copied from the client)
  imported_by UUID REFERENCES auth.users(id) DEFAULT auth.uid(),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  sheet_name TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  period_start DATE,
  period_end DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.client_statement_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),          -- firm owner (copied from the client)
  import_id UUID REFERENCES public.client_statement_imports(id) ON DELETE CASCADE,
  txn_date DATE NOT NULL,
  description TEXT NOT NULL CHECK (length(description) <= 500),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer', 'personal', 'needs_review')),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 100),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  -- Same line imported twice is skipped (date + amount + direction + description + occurrence)
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS client_statement_transactions_client_date_idx
  ON public.client_statement_transactions (client_id, txn_date);
CREATE INDEX IF NOT EXISTS client_statement_imports_client_idx
  ON public.client_statement_imports (client_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Access: the firm that owns the client, and its active team members
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_client(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.clients c
    WHERE c.id = p_client_id
      AND (
        c.user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.team_members tm
          WHERE tm.owner_id = c.user_id AND tm.user_id = auth.uid() AND tm.is_active
        )
      )
  );
$$;
REVOKE ALL ON FUNCTION public.can_access_client(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_client(UUID) TO authenticated;

-- user_id always comes from the client record, never from the browser.
CREATE OR REPLACE FUNCTION public.set_client_statement_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT user_id INTO NEW.user_id FROM public.clients WHERE id = NEW.client_id;
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'Client not found';
  END IF;
  IF TG_TABLE_NAME = 'client_statement_transactions' AND NEW.import_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.client_statement_imports i WHERE i.id = NEW.import_id AND i.client_id = NEW.client_id
  ) THEN
    RAISE EXCEPTION 'Import belongs to a different client';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_owner ON public.client_statement_imports;
CREATE TRIGGER set_owner BEFORE INSERT OR UPDATE OF client_id ON public.client_statement_imports
  FOR EACH ROW EXECUTE FUNCTION public.set_client_statement_owner();
DROP TRIGGER IF EXISTS set_owner ON public.client_statement_transactions;
CREATE TRIGGER set_owner BEFORE INSERT OR UPDATE OF client_id, import_id ON public.client_statement_transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_client_statement_owner();

CREATE OR REPLACE FUNCTION public.client_statement_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_client_statement_transactions_updated_at ON public.client_statement_transactions;
CREATE TRIGGER update_client_statement_transactions_updated_at
  BEFORE UPDATE ON public.client_statement_transactions
  FOR EACH ROW EXECUTE FUNCTION public.client_statement_touch_updated_at();

ALTER TABLE public.client_statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_statement_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Firm can view client imports" ON public.client_statement_imports;
DROP POLICY IF EXISTS "Firm can add client imports" ON public.client_statement_imports;
DROP POLICY IF EXISTS "Firm can update client imports" ON public.client_statement_imports;
DROP POLICY IF EXISTS "Firm can delete client imports" ON public.client_statement_imports;
CREATE POLICY "Firm can view client imports" ON public.client_statement_imports
  FOR SELECT USING (public.can_access_client(client_id));
CREATE POLICY "Firm can add client imports" ON public.client_statement_imports
  FOR INSERT WITH CHECK (public.can_access_client(client_id));
CREATE POLICY "Firm can update client imports" ON public.client_statement_imports
  FOR UPDATE USING (public.can_access_client(client_id)) WITH CHECK (public.can_access_client(client_id));
CREATE POLICY "Firm can delete client imports" ON public.client_statement_imports
  FOR DELETE USING (public.can_access_client(client_id));

DROP POLICY IF EXISTS "Firm can view client statement lines" ON public.client_statement_transactions;
DROP POLICY IF EXISTS "Firm can add client statement lines" ON public.client_statement_transactions;
DROP POLICY IF EXISTS "Firm can update client statement lines" ON public.client_statement_transactions;
DROP POLICY IF EXISTS "Firm can delete client statement lines" ON public.client_statement_transactions;
CREATE POLICY "Firm can view client statement lines" ON public.client_statement_transactions
  FOR SELECT USING (public.can_access_client(client_id));
CREATE POLICY "Firm can add client statement lines" ON public.client_statement_transactions
  FOR INSERT WITH CHECK (public.can_access_client(client_id));
CREATE POLICY "Firm can update client statement lines" ON public.client_statement_transactions
  FOR UPDATE USING (public.can_access_client(client_id)) WITH CHECK (public.can_access_client(client_id));
CREATE POLICY "Firm can delete client statement lines" ON public.client_statement_transactions
  FOR DELETE USING (public.can_access_client(client_id));
