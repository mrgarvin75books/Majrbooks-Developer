-- =============================================================================
-- Fix: importing a client bank statement failed with
--   record "new" has no field "import_id"
--
-- set_client_statement_owner() runs on both client_statement_imports and
-- client_statement_transactions. It read NEW.import_id inside an AND that also
-- checked the table name, but PL/pgSQL doesn't promise to skip the rest of an
-- AND, so on client_statement_imports (which has no import_id) it failed.
-- The import_id check now sits in its own IF that only runs for the
-- transactions table.
--
-- Safe to run more than once (CREATE OR REPLACE); can be pasted into the
-- Supabase SQL editor on its own.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_client_statement_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_import_id UUID;
BEGIN
  SELECT user_id INTO NEW.user_id FROM public.clients WHERE id = NEW.client_id;
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'Client not found';
  END IF;

  IF TG_TABLE_NAME = 'client_statement_transactions' THEN
    v_import_id := NEW.import_id;
    IF v_import_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.client_statement_imports i
      WHERE i.id = v_import_id AND i.client_id = NEW.client_id
    ) THEN
      RAISE EXCEPTION 'Import belongs to a different client';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
