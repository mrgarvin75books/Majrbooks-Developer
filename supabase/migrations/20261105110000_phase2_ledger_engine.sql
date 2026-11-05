-- =============================================================================
-- Phase 2 (blueprint) — part 2: chart of accounts + posting engine
--
-- One posting path writes journal lines: _post_entry(). It enforces the
-- blueprint's validation rules (V-numbers below). Journal tables have no
-- write policies, so the API cannot bypass it.
--
-- Ledger definition used by every report: lines of entries whose status is
-- 'posted' or 'voided'. A voided entry stays in the ledger and is cancelled
-- by its (posted) reversing entry, so history for past periods never changes.
-- Drafts are not in the ledger. See view public.ledger_lines.
--
-- Existing journal entries are kept untouched and flagged is_legacy.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Chart of accounts
-- -----------------------------------------------------------------------------
ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS account_number TEXT,
  ADD COLUMN IF NOT EXISTS account_class TEXT
    CHECK (account_class IN ('asset', 'liability', 'equity', 'income', 'cogs', 'expense')),
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.chart_of_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS system_key TEXT,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS normal_balance TEXT GENERATED ALWAYS AS (
    CASE
      WHEN account_class IN ('asset', 'cogs', 'expense') THEN 'debit'
      WHEN account_class IN ('liability', 'equity', 'income') THEN 'credit'
    END
  ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS chart_of_accounts_number_per_business
  ON public.chart_of_accounts (business_id, account_number) WHERE account_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chart_of_accounts_system_key_per_business
  ON public.chart_of_accounts (business_id, system_key) WHERE system_key IS NOT NULL;

-- Map the free-text account_type the app has used (two vocabularies:
-- "Asset/Liability/..." and QuickBooks-style "Bank/Other Current Assets/...")
-- onto the six blueprint classes.
CREATE OR REPLACE FUNCTION public.classify_account_type(p_type TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type IS NULL THEN NULL
    WHEN lower(p_type) ~ '(cost of goods|cogs|cost of sales)' THEN 'cogs'
    WHEN lower(p_type) ~ '(expense)' THEN 'expense'
    WHEN lower(p_type) ~ '(income|revenue|sales)' THEN 'income'
    WHEN lower(p_type) ~ '(equity|capital|retained)' THEN 'equity'
    WHEN lower(p_type) ~ '(liabilit|payable|credit card|loan)' THEN 'liability'
    WHEN lower(p_type) ~ '(asset|bank|cash|receivable|inventory|checking|savings)' THEN 'asset'
    ELSE NULL
  END;
$$;

UPDATE public.chart_of_accounts
SET account_class = public.classify_account_type(account_type)
WHERE account_class IS NULL;

-- Runs as the caller (not SECURITY DEFINER) so current_user tells API writes
-- apart from internal engine writes.
CREATE OR REPLACE FUNCTION public.guard_chart_of_accounts()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_has_lines BOOLEAN;
  v_internal BOOLEAN := current_user NOT IN ('authenticated', 'anon');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'SYSTEM_ACCOUNT: "%" is a system account and cannot be deleted', OLD.name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE account_id = OLD.id) THEN
      RAISE EXCEPTION 'ACCOUNT_IN_USE: "%" has transactions; make it inactive instead of deleting it', OLD.name;
    END IF;
    RETURN OLD;
  END IF;

  -- Derive the class from the free-text type when the caller doesn't send one.
  IF NEW.account_class IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.account_type IS DISTINCT FROM OLD.account_type
         AND NEW.account_class IS NOT DISTINCT FROM OLD.account_class) THEN
    NEW.account_class := COALESCE(public.classify_account_type(NEW.account_type), NEW.account_class);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT v_internal THEN
      NEW.is_system := false;
      NEW.system_key := NULL;
    END IF;
    IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.chart_of_accounts p WHERE p.id = NEW.parent_id AND p.business_id = NEW.business_id
    ) THEN
      RAISE EXCEPTION 'CROSS_BUSINESS_REFERENCE: parent account belongs to another business';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  NEW.business_id := OLD.business_id;
  IF NOT v_internal THEN
    NEW.is_system := OLD.is_system;
    NEW.system_key := OLD.system_key;
  END IF;

  IF NEW.parent_id IS NOT NULL AND (NEW.parent_id = NEW.id OR NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts p WHERE p.id = NEW.parent_id AND p.business_id = NEW.business_id
  )) THEN
    RAISE EXCEPTION 'CROSS_BUSINESS_REFERENCE: invalid parent account';
  END IF;

  IF OLD.is_system THEN  -- V16
    IF NEW.account_class IS DISTINCT FROM OLD.account_class THEN
      RAISE EXCEPTION 'SYSTEM_ACCOUNT: the type of "%" cannot be changed', OLD.name;
    END IF;
    IF NEW.is_active = false OR NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'SYSTEM_ACCOUNT: "%" cannot be made inactive', OLD.name;
    END IF;
  END IF;

  -- An account with postings cannot move between balance sheet and P&L.
  IF NEW.account_class IS DISTINCT FROM OLD.account_class AND OLD.account_class IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE account_id = OLD.id) INTO v_has_lines;
    IF v_has_lines AND
       ((OLD.account_class IN ('asset', 'liability', 'equity')) <> (NEW.account_class IN ('asset', 'liability', 'equity'))) THEN
      RAISE EXCEPTION 'ACCOUNT_IN_USE: "%" has transactions, so it cannot move between the balance sheet and profit and loss', OLD.name;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS b_guard_chart_of_accounts ON public.chart_of_accounts;
CREATE TRIGGER b_guard_chart_of_accounts
  BEFORE INSERT OR UPDATE OR DELETE ON public.chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION public.guard_chart_of_accounts();

-- Deleting an account used to silently delete its bank transactions.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'public.bank_transactions'::regclass AND con.contype = 'f'
      AND att.attname = 'account_id'
  LOOP
    EXECUTE format('ALTER TABLE public.bank_transactions DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_transactions_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES public.chart_of_accounts(id) ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 2. System accounts
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.system_account_spec(p_key TEXT,
  OUT name TEXT, OUT account_class TEXT, OUT account_type TEXT, OUT detail_type TEXT, OUT account_number TEXT)
LANGUAGE sql IMMUTABLE AS $$
  SELECT s.name, s.account_class, s.account_type, s.detail_type, s.account_number FROM (VALUES
    ('undeposited_funds',      'Undeposited Funds',      'asset',     'Asset',     'UndepositedFunds',     '1050'),
    ('accounts_receivable',    'Accounts Receivable',    'asset',     'Asset',     'AccountsReceivable',   '1200'),
    ('accounts_payable',       'Accounts Payable',       'liability', 'Liability', 'AccountsPayable',      '2000'),
    ('sales_tax_payable',      'Sales Tax Payable',      'liability', 'Liability', 'SalesTaxPayable',      '2200'),
    ('opening_balance_equity', 'Opening Balance Equity', 'equity',    'Equity',    'OpeningBalanceEquity', '3000'),
    ('retained_earnings',      'Retained Earnings',      'equity',    'Equity',    'RetainedEarnings',     '3100'),
    ('sales',                  'Sales',                  'income',    'Income',    'SalesRevenue',         '4000'),
    ('uncategorized_income',   'Uncategorized Income',   'income',    'Income',    'OtherIncome',          '4900'),
    ('uncategorized_expense',  'Uncategorized Expense',  'expense',   'Expense',   'OtherExpense',         '6900')
  ) AS s(key, name, account_class, account_type, detail_type, account_number)
  WHERE s.key = p_key;
$$;

-- Returns the business's system account for p_key, creating it (or adopting
-- an existing account with the same name and class) if needed.
CREATE OR REPLACE FUNCTION public._system_account(p_business_id UUID, p_key TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id UUID;
  s RECORD;
  v_owner UUID;
  v_adopt_names TEXT[];
BEGIN
  SELECT id INTO v_id FROM public.chart_of_accounts
  WHERE business_id = p_business_id AND system_key = p_key;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT * INTO s FROM public.system_account_spec(p_key);
  IF s.name IS NULL THEN
    RAISE EXCEPTION 'Unknown system account %', p_key;
  END IF;
  SELECT owner_user_id INTO v_owner FROM public.businesses WHERE id = p_business_id;

  -- Accounts the old invoice triggers created by name are adopted.
  v_adopt_names := CASE p_key WHEN 'sales' THEN ARRAY['Sales', 'Revenue'] ELSE ARRAY[s.name] END;
  SELECT id INTO v_id FROM public.chart_of_accounts
  WHERE business_id = p_business_id AND system_key IS NULL
    AND name = ANY (v_adopt_names) AND account_class = s.account_class
  ORDER BY array_position(v_adopt_names, name), created_at
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    UPDATE public.chart_of_accounts
    SET system_key = p_key, is_system = true, is_active = true, archived_at = NULL,
        account_number = COALESCE(account_number,
          CASE WHEN EXISTS (SELECT 1 FROM public.chart_of_accounts x
                            WHERE x.business_id = p_business_id AND x.account_number = s.account_number)
               THEN NULL ELSE s.account_number END)
    WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.chart_of_accounts
    (user_id, business_id, name, account_type, detail_type, account_class, is_system, system_key, account_number, action_type)
  VALUES
    (v_owner, p_business_id, s.name, s.account_type, s.detail_type, s.account_class, true, p_key,
     CASE WHEN EXISTS (SELECT 1 FROM public.chart_of_accounts x
                       WHERE x.business_id = p_business_id AND x.account_number = s.account_number)
          THEN NULL ELSE s.account_number END,
     'register')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_system_accounts(p_business_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k TEXT;
BEGIN
  FOREACH k IN ARRAY ARRAY['undeposited_funds','accounts_receivable','accounts_payable','sales_tax_payable',
                           'opening_balance_equity','retained_earnings','sales',
                           'uncategorized_income','uncategorized_expense'] LOOP
    PERFORM public._system_account(p_business_id, k);
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Journal entries and lines
-- -----------------------------------------------------------------------------
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS entry_seq BIGINT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS reverses_entry_id UUID REFERENCES public.journal_entries(id),
  ADD COLUMN IF NOT EXISTS voided_by_entry_id UUID REFERENCES public.journal_entries(id),
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS is_legacy BOOLEAN NOT NULL DEFAULT false;

-- Everything recorded before the engine existed.
UPDATE public.journal_entries SET is_legacy = true WHERE entry_seq IS NULL AND NOT is_legacy;

ALTER TABLE public.journal_entries DROP CONSTRAINT IF EXISTS journal_entries_status_check;
ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_status_check CHECK (status IN ('draft', 'posted', 'voided')) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_seq_per_business
  ON public.journal_entries (business_id, entry_seq) WHERE entry_seq IS NOT NULL;
-- V7: a source document posts at most once.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_posting_per_source
  ON public.journal_entries (business_id, source_type, source_id)
  WHERE status = 'posted' AND source_id IS NOT NULL AND reverses_entry_id IS NULL AND NOT is_legacy;
-- V8: idempotency.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_idempotency
  ON public.journal_entries (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_entries_source_idx ON public.journal_entries (source_type, source_id);

ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS line_no INTEGER;

-- V2 / V15 for new lines (existing lines are left as they are).
ALTER TABLE public.journal_entry_lines DROP CONSTRAINT IF EXISTS journal_entry_lines_amounts_check;
ALTER TABLE public.journal_entry_lines
  ADD CONSTRAINT journal_entry_lines_amounts_check CHECK (
    debit >= 0 AND credit >= 0
    AND ((debit > 0) <> (credit > 0))
    AND debit = round(debit, 2) AND credit = round(credit, 2)
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.business_sequences (
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  last_value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, name)
);
ALTER TABLE public.business_sequences ENABLE ROW LEVEL SECURITY;  -- no policies: internal only

CREATE OR REPLACE FUNCTION public._next_sequence(p_business_id UUID, p_name TEXT)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.business_sequences (business_id, name, last_value)
  VALUES (p_business_id, p_name, 1)
  ON CONFLICT (business_id, name) DO UPDATE SET last_value = public.business_sequences.last_value + 1
  RETURNING last_value;
$$;

-- V3, V6 and V4 on lines.
CREATE OR REPLACE FUNCTION public.guard_journal_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entry RECORD;
  v_account RECORD;
BEGIN
  SELECT id, business_id, status INTO v_entry FROM public.journal_entries
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF TG_OP = 'DELETE' THEN
    IF v_entry.id IS NOT NULL AND v_entry.status <> 'draft' THEN
      RAISE EXCEPTION 'ENTRY_IMMUTABLE: lines of a posted entry cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF v_entry.status <> 'draft' OR (TG_OP = 'UPDATE' AND OLD.journal_entry_id <> NEW.journal_entry_id) THEN
    RAISE EXCEPTION 'ENTRY_IMMUTABLE: lines of a posted entry cannot be changed';
  END IF;

  NEW.business_id := v_entry.business_id;

  SELECT id, business_id, name, is_active, archived_at, account_class INTO v_account
  FROM public.chart_of_accounts WHERE id = NEW.account_id;
  IF v_account.id IS NULL OR v_account.business_id <> v_entry.business_id THEN
    RAISE EXCEPTION 'CROSS_BUSINESS_REFERENCE: account does not belong to this business';
  END IF;
  IF NOT v_account.is_active OR v_account.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNT_ARCHIVED: "%" is inactive and cannot receive new transactions', v_account.name;
  END IF;
  IF v_account.account_class IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_UNCLASSIFIED: set the account type of "%" before posting to it', v_account.name;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS b_guard_journal_line ON public.journal_entry_lines;
CREATE TRIGGER b_guard_journal_line
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_journal_line();

-- V4 / V5 on entries.
CREATE OR REPLACE FUNCTION public.guard_journal_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lock DATE;
  v_excluded TEXT[] := ARRAY['status', 'voided_by_entry_id', 'voided_at', 'void_reason', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'ENTRY_IMMUTABLE: posted entries cannot be deleted; void or reverse them instead';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.business_id := OLD.business_id;
    IF OLD.status IN ('posted', 'voided') THEN
      IF NOT (OLD.status = 'posted' AND NEW.status = 'voided')
         OR (to_jsonb(NEW) - v_excluded) IS DISTINCT FROM (to_jsonb(OLD) - v_excluded) THEN
        RAISE EXCEPTION 'ENTRY_IMMUTABLE: posted entries cannot be changed; void or reverse them instead';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  -- Posting (insert as posted, or draft -> posted): V5 lock date.
  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    SELECT lock_date INTO v_lock FROM public.businesses WHERE id = NEW.business_id;
    IF v_lock IS NOT NULL AND NEW.entry_date <= v_lock THEN
      RAISE EXCEPTION 'PERIOD_LOCKED: the books are closed through %; date the entry after that or ask an accountant to change the lock date', v_lock;
    END IF;
    NEW.posted_at := COALESCE(NEW.posted_at, now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS b_guard_journal_entry ON public.journal_entries;
CREATE TRIGGER b_guard_journal_entry
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_journal_entry();

-- V1 / V2: checked at commit, so an entry can be built line by line inside
-- one transaction but can never be committed as posted while unbalanced.
CREATE OR REPLACE FUNCTION public.check_entry_balanced()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status TEXT;
  v_legacy BOOLEAN;
  v_count INTEGER;
  v_debit NUMERIC;
  v_credit NUMERIC;
BEGIN
  SELECT status, is_legacy INTO v_status, v_legacy FROM public.journal_entries WHERE id = NEW.id;
  IF v_status IS NULL OR v_status = 'draft' OR v_legacy THEN
    RETURN NULL;
  END IF;
  SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO v_count, v_debit, v_credit
  FROM public.journal_entry_lines WHERE journal_entry_id = NEW.id;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'INVALID_LINE: a journal entry needs at least two lines';
  END IF;
  IF v_debit <> v_credit OR v_debit = 0 THEN
    RAISE EXCEPTION 'ENTRY_UNBALANCED: debits (%) must equal credits (%)', v_debit, v_credit;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_check_entry_balanced ON public.journal_entries;
CREATE CONSTRAINT TRIGGER z_check_entry_balanced
  AFTER INSERT OR UPDATE ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_entry_balanced();

-- The ledger: what every report reads.
CREATE OR REPLACE VIEW public.ledger_lines
WITH (security_invoker = on) AS
SELECT
  l.id AS line_id,
  l.business_id,
  e.id AS entry_id,
  e.entry_number,
  e.entry_date,
  e.status,
  e.description AS memo,
  e.reference,
  e.source_type,
  e.source_id,
  l.line_no,
  l.account_id,
  l.description,
  l.debit,
  l.credit
FROM public.journal_entry_lines l
JOIN public.journal_entries e ON e.id = l.journal_entry_id
WHERE e.status IN ('posted', 'voided');

-- -----------------------------------------------------------------------------
-- 4. Audit
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._audit(p_business_id UUID, p_action TEXT, p_entity_type TEXT,
                                         p_entity_id UUID, p_details JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.audit_logs (owner_id, user_id, business_id, action, entity_type, entity_id, details)
  SELECT b.owner_user_id, auth.uid(), b.id, p_action, p_entity_type, p_entity_id, p_details
  FROM public.businesses b WHERE b.id = p_business_id;
$$;

-- -----------------------------------------------------------------------------
-- 5. Posting service
-- -----------------------------------------------------------------------------
-- p_lines: JSON array of {account_id, debit, credit, description}; amounts as
-- numbers or decimal strings, in dollars with at most 2 decimals.
CREATE OR REPLACE FUNCTION public._post_entry(
  p_business_id UUID,
  p_entry_date DATE,
  p_memo TEXT,
  p_reference TEXT,
  p_lines JSONB,
  p_source_type TEXT,
  p_source_id UUID,
  p_idempotency_key TEXT DEFAULT NULL,
  p_as_draft BOOLEAN DEFAULT false,
  p_reverses_entry_id UUID DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_business RECORD;
  v_existing UUID;
  v_entry_id UUID;
  v_seq BIGINT;
  v_line JSONB;
  v_n INTEGER := 0;
  v_debit NUMERIC;
  v_credit NUMERIC;
  v_total_debit NUMERIC := 0;
  v_total_credit NUMERIC := 0;
BEGIN
  SELECT id, owner_user_id, lock_date, archived_at INTO v_business
  FROM public.businesses WHERE id = p_business_id;
  IF v_business.id IS NULL OR v_business.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: business not found';
  END IF;

  -- V8
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing FROM public.journal_entries
    WHERE business_id = p_business_id AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  IF p_entry_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_DATE: entry date is required';
  END IF;
  -- V5 (also enforced by the entry trigger)
  IF NOT p_as_draft AND v_business.lock_date IS NOT NULL AND p_entry_date <= v_business.lock_date THEN
    RAISE EXCEPTION 'PERIOD_LOCKED: the books are closed through %', v_business.lock_date;
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'INVALID_LINE: a journal entry needs at least two lines';
  END IF;

  -- Validate amounts before writing anything (V1, V2, V15).
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    BEGIN
      v_debit := COALESCE(NULLIF(v_line->>'debit', '')::numeric, 0);
      v_credit := COALESCE(NULLIF(v_line->>'credit', '')::numeric, 0);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'INVALID_AMOUNT: amounts must be numbers';
    END;
    IF v_debit < 0 OR v_credit < 0 OR ((v_debit > 0) = (v_credit > 0)) THEN
      RAISE EXCEPTION 'INVALID_LINE: each line needs either a debit or a credit greater than zero, not both';
    END IF;
    IF v_debit <> round(v_debit, 2) OR v_credit <> round(v_credit, 2) THEN
      RAISE EXCEPTION 'INVALID_AMOUNT: amounts can have at most two decimal places';
    END IF;
    IF NULLIF(v_line->>'account_id', '') IS NULL THEN
      RAISE EXCEPTION 'INVALID_LINE: every line needs an account';
    END IF;
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  END LOOP;
  IF NOT p_as_draft AND v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'ENTRY_UNBALANCED: debits (%) must equal credits (%)', v_total_debit, v_total_credit;
  END IF;

  v_seq := public._next_sequence(p_business_id, 'journal_entry');

  INSERT INTO public.journal_entries
    (user_id, business_id, entry_seq, entry_number, entry_date, description, reference, status,
     source_type, source_id, idempotency_key, created_by, reverses_entry_id)
  VALUES
    (v_business.owner_user_id, p_business_id, v_seq, 'JE-' || lpad(v_seq::text, 6, '0'), p_entry_date,
     NULLIF(trim(p_memo), ''), NULLIF(trim(p_reference), ''), 'draft',
     COALESCE(p_source_type, 'manual'), p_source_id, p_idempotency_key, auth.uid(), p_reverses_entry_id)
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_n := v_n + 1;
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, business_id, line_no, account_id, description, debit, credit)
    VALUES
      (v_entry_id, p_business_id, v_n, (v_line->>'account_id')::uuid, NULLIF(trim(v_line->>'description'), ''),
       COALESCE(NULLIF(v_line->>'debit', '')::numeric, 0), COALESCE(NULLIF(v_line->>'credit', '')::numeric, 0));
  END LOOP;

  IF NOT p_as_draft THEN
    UPDATE public.journal_entries
    SET status = 'posted', posted_at = now(), posted_by = auth.uid()
    WHERE id = v_entry_id;
  END IF;

  PERFORM public._audit(p_business_id, CASE WHEN p_as_draft THEN 'journal_entry_drafted' ELSE 'journal_entry_posted' END,
                        'journal_entry', v_entry_id,
                        jsonb_build_object('source_type', COALESCE(p_source_type, 'manual'), 'source_id', p_source_id,
                                           'total', v_total_debit, 'entry_date', p_entry_date));
  RETURN v_entry_id;
END;
$$;

-- Voids a posted entry by posting its mirror. Dated the same day when that
-- period is open; otherwise (locked period) dated p_fallback_date, which is
-- how the blueprint says to correct closed periods. The original stays in
-- the ledger, marked voided.
CREATE OR REPLACE FUNCTION public._void_entry(p_entry_id UUID, p_reason TEXT,
                                              p_fallback_date DATE DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entry RECORD;
  v_lock DATE;
  v_date DATE;
  v_lines JSONB;
  v_reversal UUID;
BEGIN
  SELECT * INTO v_entry FROM public.journal_entries WHERE id = p_entry_id FOR UPDATE;
  IF v_entry.id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: journal entry not found';
  END IF;
  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'ENTRY_IMMUTABLE: only posted entries can be voided';
  END IF;

  SELECT lock_date INTO v_lock FROM public.businesses WHERE id = v_entry.business_id;
  v_date := v_entry.entry_date;
  IF v_lock IS NOT NULL AND v_date <= v_lock THEN
    IF p_fallback_date IS NULL OR p_fallback_date <= v_lock THEN
      RAISE EXCEPTION 'PERIOD_LOCKED: the books are closed through %; reverse this entry with a date after that instead', v_lock;
    END IF;
    v_date := p_fallback_date;
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'account_id', account_id, 'debit', credit, 'credit', debit,
           'description', description) ORDER BY line_no NULLS LAST, created_at)
    INTO v_lines
  FROM public.journal_entry_lines WHERE journal_entry_id = p_entry_id;

  v_reversal := public._post_entry(
    v_entry.business_id, v_date,
    'Void of ' || v_entry.entry_number || COALESCE(': ' || NULLIF(trim(p_reason), ''), ''),
    v_entry.reference, v_lines, v_entry.source_type, v_entry.source_id,
    NULL, false, p_entry_id);

  UPDATE public.journal_entries
  SET status = 'voided', voided_by_entry_id = v_reversal, voided_at = now(), void_reason = NULLIF(trim(p_reason), '')
  WHERE id = p_entry_id;

  PERFORM public._audit(v_entry.business_id, 'journal_entry_voided', 'journal_entry', p_entry_id,
                        jsonb_build_object('reversal_entry_id', v_reversal, 'reason', p_reason));
  RETURN v_reversal;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Public API (role-checked)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_journal_entry(
  p_business_id UUID,
  p_entry_date DATE,
  p_memo TEXT,
  p_reference TEXT,
  p_lines JSONB,
  p_idempotency_key TEXT DEFAULT NULL,
  p_as_draft BOOLEAN DEFAULT false
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_keep_books(p_business_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: business not found';  -- 404, not 403
  END IF;
  RETURN public._post_entry(p_business_id, p_entry_date, p_memo, p_reference, p_lines,
                            'manual', NULL, p_idempotency_key, p_as_draft, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.post_draft_entry(p_entry_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_entry RECORD;
BEGIN
  SELECT id, business_id, status INTO v_entry FROM public.journal_entries WHERE id = p_entry_id;
  IF v_entry.id IS NULL OR NOT public.can_keep_books(v_entry.business_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: journal entry not found';
  END IF;
  IF v_entry.status <> 'draft' THEN
    RAISE EXCEPTION 'ENTRY_IMMUTABLE: this entry is already posted';
  END IF;
  UPDATE public.journal_entries SET status = 'posted', posted_at = now(), posted_by = auth.uid()
  WHERE id = p_entry_id;
  PERFORM public._audit(v_entry.business_id, 'journal_entry_posted', 'journal_entry', p_entry_id, '{}'::jsonb);
  RETURN p_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_draft_entry(p_entry_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_entry RECORD;
BEGIN
  SELECT id, business_id, status, entry_number INTO v_entry FROM public.journal_entries WHERE id = p_entry_id;
  IF v_entry.id IS NULL OR NOT public.can_keep_books(v_entry.business_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: journal entry not found';
  END IF;
  IF v_entry.status <> 'draft' THEN
    RAISE EXCEPTION 'ENTRY_IMMUTABLE: posted entries cannot be deleted; void or reverse them instead';
  END IF;
  DELETE FROM public.journal_entries WHERE id = p_entry_id;
  PERFORM public._audit(v_entry.business_id, 'journal_entry_draft_deleted', 'journal_entry', p_entry_id,
                        jsonb_build_object('entry_number', v_entry.entry_number));
END;
$$;

-- Manual entries only; entries created by invoices and payments are
-- corrected through their source document.
CREATE OR REPLACE FUNCTION public.void_journal_entry(p_entry_id UUID, p_reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_entry RECORD;
BEGIN
  SELECT id, business_id, source_type INTO v_entry FROM public.journal_entries WHERE id = p_entry_id;
  IF v_entry.id IS NULL OR NOT public.can_keep_books(v_entry.business_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: journal entry not found';
  END IF;
  IF COALESCE(v_entry.source_type, 'manual') <> 'manual' THEN
    RAISE EXCEPTION 'SOURCE_DOCUMENT: this entry was created by a % — change or cancel the % instead', v_entry.source_type, v_entry.source_type;
  END IF;
  IF coalesce(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: enter a reason for voiding this entry';
  END IF;
  RETURN public._void_entry(p_entry_id, p_reason, NULL);
END;
$$;

-- Posts the mirror entry on a new date (accrual reversals, corrections after
-- a lock date). The original stays posted.
CREATE OR REPLACE FUNCTION public.reverse_journal_entry(p_entry_id UUID, p_reversal_date DATE, p_memo TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entry RECORD;
  v_lines JSONB;
  v_new UUID;
BEGIN
  SELECT * INTO v_entry FROM public.journal_entries WHERE id = p_entry_id;
  IF v_entry.id IS NULL OR NOT public.can_keep_books(v_entry.business_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: journal entry not found';
  END IF;
  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'ENTRY_IMMUTABLE: only posted entries can be reversed';
  END IF;
  IF COALESCE(v_entry.source_type, 'manual') <> 'manual' THEN
    RAISE EXCEPTION 'SOURCE_DOCUMENT: this entry was created by a % — change or cancel the % instead', v_entry.source_type, v_entry.source_type;
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE reverses_entry_id = p_entry_id AND status = 'posted') THEN
    RAISE EXCEPTION 'ALREADY_REVERSED: this entry has already been reversed';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'account_id', account_id, 'debit', credit, 'credit', debit,
           'description', description) ORDER BY line_no NULLS LAST, created_at)
    INTO v_lines
  FROM public.journal_entry_lines WHERE journal_entry_id = p_entry_id;

  v_new := public._post_entry(v_entry.business_id, p_reversal_date,
                              COALESCE(NULLIF(trim(p_memo), ''), 'Reversal of ' || v_entry.entry_number),
                              v_entry.reference, v_lines, 'manual', NULL, NULL, false, p_entry_id);
  PERFORM public._audit(v_entry.business_id, 'journal_entry_reversed', 'journal_entry', p_entry_id,
                        jsonb_build_object('reversal_entry_id', v_new, 'reversal_date', p_reversal_date));
  RETURN v_new;
END;
$$;

-- Close the books through a date. Moving the lock date earlier (reopening a
-- closed period) requires a reason; every change is logged.
CREATE OR REPLACE FUNCTION public.set_lock_date(p_business_id UUID, p_lock_date DATE, p_reason TEXT DEFAULT NULL)
RETURNS DATE LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old DATE;
BEGIN
  IF NOT public.can_keep_books(p_business_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: business not found';
  END IF;
  SELECT lock_date INTO v_old FROM public.businesses WHERE id = p_business_id FOR UPDATE;
  IF (p_lock_date IS NULL AND v_old IS NOT NULL) OR (v_old IS NOT NULL AND p_lock_date < v_old) THEN
    IF coalesce(trim(p_reason), '') = '' THEN
      RAISE EXCEPTION 'REASON_REQUIRED: reopening a closed period requires a reason';
    END IF;
  END IF;
  UPDATE public.businesses SET lock_date = p_lock_date WHERE id = p_business_id;
  PERFORM public._audit(p_business_id, 'lock_date_changed', 'business', p_business_id,
                        jsonb_build_object('from', v_old, 'to', p_lock_date, 'reason', p_reason));
  RETURN p_lock_date;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Ledger read functions
-- -----------------------------------------------------------------------------
-- Balance of every account as of a date (or for a date range), signed by the
-- account's normal balance.
CREATE OR REPLACE FUNCTION public.account_balances(p_business_id UUID, p_to DATE, p_from DATE DEFAULT NULL)
RETURNS TABLE (account_id UUID, account_number TEXT, name TEXT, account_class TEXT, normal_balance TEXT,
               total_debit NUMERIC, total_credit NUMERIC, balance NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_business_member(p_business_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: business not found';
  END IF;
  RETURN QUERY
  SELECT a.id, a.account_number, a.name, a.account_class, a.normal_balance,
         COALESCE(sum(l.debit), 0), COALESCE(sum(l.credit), 0),
         CASE WHEN a.normal_balance = 'credit'
              THEN COALESCE(sum(l.credit), 0) - COALESCE(sum(l.debit), 0)
              ELSE COALESCE(sum(l.debit), 0) - COALESCE(sum(l.credit), 0) END
  FROM public.chart_of_accounts a
  LEFT JOIN public.ledger_lines l
    ON l.account_id = a.id
   AND l.entry_date <= p_to
   AND (p_from IS NULL OR l.entry_date >= p_from)
  WHERE a.business_id = p_business_id
  GROUP BY a.id, a.account_number, a.name, a.account_class, a.normal_balance
  ORDER BY a.account_number NULLS LAST, a.name;
END;
$$;

-- V13: the trial balance nets to zero. Returns any problems found.
CREATE OR REPLACE FUNCTION public.ledger_integrity(p_business_id UUID)
RETURNS TABLE (check_name TEXT, ok BOOLEAN, detail TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_debit NUMERIC;
  v_credit NUMERIC;
  v_bad INTEGER;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_business_member(p_business_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: business not found';
  END IF;

  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0) INTO v_debit, v_credit
  FROM public.ledger_lines WHERE business_id = p_business_id;
  RETURN QUERY SELECT 'trial_balance_nets_to_zero'::text, v_debit = v_credit,
                      format('debits %s, credits %s', v_debit, v_credit);

  SELECT count(*) INTO v_bad FROM (
    SELECT e.id FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE e.business_id = p_business_id AND e.status IN ('posted', 'voided')
    GROUP BY e.id HAVING sum(l.debit) <> sum(l.credit)
  ) x;
  RETURN QUERY SELECT 'every_entry_balanced'::text, v_bad = 0, format('%s unbalanced entries (legacy data)', v_bad);

  SELECT count(*) INTO v_bad FROM public.chart_of_accounts
  WHERE business_id = p_business_id AND account_class IS NULL;
  RETURN QUERY SELECT 'every_account_classified'::text, v_bad = 0, format('%s accounts without a type', v_bad);
END;
$$;

-- Account register: running balance from the ledger (blueprint "register").
CREATE OR REPLACE FUNCTION public.account_register(p_account_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (entry_id UUID, entry_number TEXT, entry_date DATE, memo TEXT, line_description TEXT,
               source_type TEXT, status TEXT, debit NUMERIC, credit NUMERIC, balance NUMERIC, is_opening BOOLEAN)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account RECORD;
  v_opening NUMERIC;
  v_sign INTEGER;
BEGIN
  SELECT id, business_id, normal_balance INTO v_account FROM public.chart_of_accounts WHERE id = p_account_id;
  IF v_account.id IS NULL OR NOT public.is_business_member(v_account.business_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: account not found';
  END IF;
  v_sign := CASE WHEN v_account.normal_balance = 'credit' THEN -1 ELSE 1 END;

  SELECT COALESCE(sum(l.debit - l.credit), 0) * v_sign INTO v_opening
  FROM public.ledger_lines l
  WHERE l.account_id = p_account_id AND l.entry_date < p_from;

  RETURN QUERY
  SELECT NULL::uuid, NULL::text, p_from, 'Opening balance'::text, NULL::text, NULL::text, NULL::text,
         NULL::numeric, NULL::numeric, v_opening, true;

  RETURN QUERY
  SELECT l.entry_id, l.entry_number, l.entry_date, l.memo, l.description, l.source_type, l.status,
         l.debit, l.credit,
         v_opening + v_sign * sum(l.debit - l.credit) OVER (ORDER BY l.entry_date, l.entry_number, l.line_no
                                                           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
         false
  FROM public.ledger_lines l
  WHERE l.account_id = p_account_id AND l.entry_date BETWEEN p_from AND p_to
  ORDER BY l.entry_date, l.entry_number, l.line_no;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Sales documents post through the engine
--    Invoice: Dr Accounts Receivable / Cr Sales, Cr Sales Tax Payable
--    Payment: Dr Undeposited Funds / Cr Accounts Receivable
--    Edits void and re-post; cancelling or deleting voids.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._live_source_entry(p_source_type TEXT, p_source_id UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.journal_entries
  WHERE source_type = p_source_type AND source_id = p_source_id AND status = 'posted'
    AND reverses_entry_id IS NULL
  ORDER BY created_at DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.generate_invoice_journal_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_business UUID;
  v_live UUID;
  v_should_post BOOLEAN;
  v_total NUMERIC;
  v_tax NUMERIC;
  v_sales NUMERIC;
  v_lines JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_live := public._live_source_entry('invoice', OLD.id);
    IF v_live IS NOT NULL THEN
      PERFORM public._void_entry(v_live, 'Invoice ' || OLD.invoice_number || ' deleted', CURRENT_DATE);
    END IF;
    RETURN OLD;
  END IF;

  v_should_post := NEW.status NOT IN ('draft', 'cancelled');
  v_live := public._live_source_entry('invoice', NEW.id);

  -- Payments already applied keep their credit to Accounts Receivable, so the
  -- invoice they pay must stay at least that large and cannot be cancelled.
  IF TG_OP = 'UPDATE' AND COALESCE(NEW.amount_paid, 0) > 0 THEN
    IF NEW.status IN ('draft', 'cancelled') AND OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'INVOICE_HAS_PAYMENTS: delete the payments recorded on invoice % before cancelling it', NEW.invoice_number;
    END IF;
    IF NEW.amount < NEW.amount_paid THEN
      RAISE EXCEPTION 'INVOICE_HAS_PAYMENTS: invoice % cannot be less than the % already paid', NEW.invoice_number, NEW.amount_paid;
    END IF;
  END IF;

  -- Void the posted entry when the invoice is cancelled, returned to draft,
  -- or its amounts/date change (it is re-posted below).
  IF v_live IS NOT NULL AND TG_OP = 'UPDATE' AND (
       NOT v_should_post
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.tax IS DISTINCT FROM OLD.tax
       OR NEW.issue_date IS DISTINCT FROM OLD.issue_date) THEN
    PERFORM public._void_entry(v_live,
      CASE WHEN NOT v_should_post THEN 'Invoice ' || NEW.invoice_number || ' ' || NEW.status
           ELSE 'Invoice ' || NEW.invoice_number || ' changed' END,
      CURRENT_DATE);
    v_live := NULL;
  END IF;

  IF v_should_post AND v_live IS NULL AND COALESCE(NEW.amount, 0) > 0 THEN
    v_business := public.ensure_default_business(NEW.user_id);
    v_total := round(NEW.amount, 2);
    v_tax := LEAST(GREATEST(round(COALESCE(NEW.tax, 0), 2), 0), v_total);
    v_sales := v_total - v_tax;

    v_lines := jsonb_build_array(jsonb_build_object(
      'account_id', public._system_account(v_business, 'accounts_receivable'),
      'debit', v_total, 'description', 'Invoice to ' || NEW.client_name));
    IF v_sales > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', public._system_account(v_business, 'sales'),
        'credit', v_sales, 'description', 'Sales');
    END IF;
    IF v_tax > 0 THEN
      v_lines := v_lines || jsonb_build_object(
        'account_id', public._system_account(v_business, 'sales_tax_payable'),
        'credit', v_tax, 'description', 'Sales tax');
    END IF;
    IF jsonb_array_length(v_lines) = 1 THEN  -- defensive: never post a one-line entry
      RETURN NEW;
    END IF;

    PERFORM public._post_entry(
      v_business,
      -- Posting into a closed period is not allowed; such invoices post on today's date.
      GREATEST(COALESCE(NEW.issue_date, CURRENT_DATE),
               COALESCE((SELECT lock_date + 1 FROM public.businesses WHERE id = v_business), '-infinity'::date)),
      'Invoice ' || NEW.invoice_number || ' - ' || NEW.client_name,
      NEW.invoice_number, v_lines, 'invoice', NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoice_journal_entry_trigger ON public.invoices;
CREATE TRIGGER invoice_journal_entry_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.generate_invoice_journal_entry();

-- V10 + ownership + positive amount (replaces the Phase 0 version).
CREATE OR REPLACE FUNCTION public.enforce_invoice_payment_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invoice RECORD;
  v_open NUMERIC;
BEGIN
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: payment amount must be greater than zero';
  END IF;
  IF NEW.amount <> round(NEW.amount, 2) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: amounts can have at most two decimal places';
  END IF;
  SELECT id, user_id, amount, COALESCE(amount_paid, 0) AS amount_paid, status INTO v_invoice
  FROM public.invoices WHERE id = NEW.invoice_id;
  IF v_invoice.id IS NULL OR v_invoice.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'NOT_FOUND: invoice not found';
  END IF;
  IF v_invoice.status = 'cancelled' THEN
    RAISE EXCEPTION 'INVOICE_CANCELLED: payments cannot be recorded on a cancelled invoice';
  END IF;
  v_open := v_invoice.amount - v_invoice.amount_paid
            + CASE WHEN TG_OP = 'UPDATE' AND OLD.invoice_id = NEW.invoice_id THEN OLD.amount ELSE 0 END;
  IF NEW.amount > v_open THEN
    RAISE EXCEPTION 'OVERAPPLIED: payment of % is more than the % still owed on this invoice', NEW.amount, v_open;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._recalculate_invoice_paid(p_invoice_id UUID)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.invoices i
  SET amount_paid = p.paid,
      status = CASE
        WHEN i.status = 'cancelled' THEN i.status
        WHEN p.paid >= i.amount THEN 'paid'
        WHEN i.status IN ('paid', 'draft') THEN
          CASE WHEN i.due_date < CURRENT_DATE THEN 'overdue' ELSE 'pending' END
        ELSE i.status
      END
  FROM (SELECT COALESCE(sum(amount), 0) AS paid FROM public.invoice_payments WHERE invoice_id = p_invoice_id) p
  WHERE i.id = p_invoice_id;
$$;

CREATE OR REPLACE FUNCTION public.generate_payment_journal_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_business UUID;
  v_live UUID;
  v_invoice RECORD;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_live := public._live_source_entry('payment', OLD.id);
    IF v_live IS NOT NULL AND (TG_OP = 'DELETE'
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
        OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id) THEN
      PERFORM public._void_entry(v_live,
        CASE WHEN TG_OP = 'DELETE' THEN 'Payment deleted' ELSE 'Payment changed' END, CURRENT_DATE);
      v_live := NULL;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM public._recalculate_invoice_paid(OLD.invoice_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' OR v_live IS NULL THEN
    SELECT invoice_number, client_name INTO v_invoice FROM public.invoices WHERE id = NEW.invoice_id;
    v_business := public.ensure_default_business(NEW.user_id);
    PERFORM public._post_entry(
      v_business,
      GREATEST(NEW.payment_date,
               COALESCE((SELECT lock_date + 1 FROM public.businesses WHERE id = v_business), '-infinity'::date)),
      'Payment received for invoice ' || v_invoice.invoice_number,
      v_invoice.invoice_number,
      jsonb_build_array(
        jsonb_build_object('account_id', public._system_account(v_business, 'undeposited_funds'),
                           'debit', round(NEW.amount, 2), 'description', 'Payment via ' || NEW.payment_method),
        jsonb_build_object('account_id', public._system_account(v_business, 'accounts_receivable'),
                           'credit', round(NEW.amount, 2), 'description', 'Payment from ' || v_invoice.client_name)),
      'payment', NEW.id);
  END IF;

  PERFORM public._recalculate_invoice_paid(NEW.invoice_id);
  IF TG_OP = 'UPDATE' AND OLD.invoice_id <> NEW.invoice_id THEN
    PERFORM public._recalculate_invoice_paid(OLD.invoice_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_journal_entry_trigger ON public.invoice_payments;
CREATE TRIGGER payment_journal_entry_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.generate_payment_journal_entry();

-- -----------------------------------------------------------------------------
-- 9. Backfill system accounts for every business
-- -----------------------------------------------------------------------------
DO $$
DECLARE b RECORD;
BEGIN
  FOR b IN SELECT id FROM public.businesses LOOP
    PERFORM public.ensure_system_accounts(b.id);
  END LOOP;
END $$;

-- New default businesses get their system accounts immediately.
CREATE OR REPLACE FUNCTION public.on_business_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.business_members (business_id, user_id, role)
  VALUES (NEW.id, NEW.owner_user_id, 'owner') ON CONFLICT DO NOTHING;
  PERFORM public.ensure_system_accounts(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_business_created ON public.businesses;
CREATE TRIGGER on_business_created
  AFTER INSERT ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.on_business_created();

-- -----------------------------------------------------------------------------
-- 10. Grants: internal functions are not callable through the API
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._post_entry(UUID, DATE, TEXT, TEXT, JSONB, TEXT, UUID, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._void_entry(UUID, TEXT, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._system_account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_system_accounts(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._next_sequence(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._audit(UUID, TEXT, TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_source_entry(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recalculate_invoice_paid(UUID) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.post_journal_entry(UUID, DATE, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_draft_entry(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_draft_entry(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_journal_entry(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_journal_entry(UUID, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_lock_date(UUID, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.account_balances(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ledger_integrity(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.account_register(UUID, DATE, DATE) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.post_journal_entry(UUID, DATE, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_draft_entry(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_draft_entry(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_journal_entry(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_journal_entry(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_lock_date(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_balances(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_integrity(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_register(UUID, DATE, DATE) TO authenticated;
