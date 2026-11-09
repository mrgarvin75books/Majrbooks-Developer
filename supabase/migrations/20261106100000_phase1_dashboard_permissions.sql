-- =============================================================================
-- Blueprint Phase 1: business dashboard data + server-side permission set
--
-- business_dashboard(): every money figure comes from the ledger
-- (ledger_lines). Counts of work waiting (overdue invoices, bills due,
-- unreviewed bank lines) come from the module tables that hold that work.
--
-- my_permissions(): the blueprint permission matrix as named permission
-- strings for the caller in one business. The frontend uses it only to hide
-- buttons; the database functions enforce the same rules themselves.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.business_dashboard(
  p_business_id UUID,
  p_from DATE,
  p_to DATE,
  p_compare_from DATE DEFAULT NULL,
  p_compare_to DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner UUID;
  v_result JSONB;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_business_member(p_business_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: business not found';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'INVALID_DATE: choose a start date on or before the end date';
  END IF;
  SELECT owner_user_id INTO v_owner FROM public.businesses WHERE id = p_business_id;

  WITH acct AS (
    SELECT a.id, a.name, a.account_number, a.account_class, a.system_key, a.bank_balance,
           (a.account_class = 'asset' AND (
              a.system_key = 'undeposited_funds'
              OR lower(coalesce(a.detail_type, '') || ' ' || coalesce(a.account_type, '')) ~ '(bank|checking|saving|cash|money market|petty)'
           ) AND coalesce(a.system_key, '') <> 'accounts_receivable') AS is_cash
    FROM public.chart_of_accounts a
    WHERE a.business_id = p_business_id
  ),
  lines AS (
    SELECT l.entry_id, l.entry_date, l.account_id, l.debit, l.credit, a.account_class, a.is_cash, a.system_key
    FROM public.ledger_lines l JOIN acct a ON a.id = l.account_id
    WHERE l.business_id = p_business_id
  ),
  pl AS (
    SELECT
      COALESCE(sum(CASE WHEN account_class = 'income' AND entry_date BETWEEN p_from AND p_to THEN credit - debit END), 0) AS income,
      COALESCE(sum(CASE WHEN account_class IN ('expense', 'cogs') AND entry_date BETWEEN p_from AND p_to THEN debit - credit END), 0) AS expenses,
      COALESCE(sum(CASE WHEN account_class = 'income' AND entry_date BETWEEN p_compare_from AND p_compare_to THEN credit - debit END), 0) AS cmp_income,
      COALESCE(sum(CASE WHEN account_class IN ('expense', 'cogs') AND entry_date BETWEEN p_compare_from AND p_compare_to THEN debit - credit END), 0) AS cmp_expenses,
      COALESCE(sum(CASE WHEN is_cash AND entry_date <= p_to THEN debit - credit END), 0) AS cash,
      COALESCE(sum(CASE WHEN is_cash AND entry_date <= p_compare_to THEN debit - credit END), 0) AS cmp_cash,
      COALESCE(sum(CASE WHEN system_key = 'accounts_receivable' AND entry_date <= p_to THEN debit - credit END), 0) AS ar,
      COALESCE(sum(CASE WHEN system_key = 'accounts_payable' AND entry_date <= p_to THEN credit - debit END), 0) AS ap,
      count(*) AS line_count
    FROM lines
  ),
  months AS (
    SELECT generate_series(date_trunc('month', p_to::timestamp) - interval '11 months',
                           date_trunc('month', p_to::timestamp), interval '1 month')::date AS month_start
  ),
  monthly AS (
    SELECT m.month_start,
           COALESCE(sum(CASE WHEN l.account_class = 'income' THEN l.credit - l.debit END), 0) AS income,
           COALESCE(sum(CASE WHEN l.account_class IN ('expense', 'cogs') THEN l.debit - l.credit END), 0) AS expenses
    FROM months m
    LEFT JOIN lines l ON l.entry_date >= m.month_start AND l.entry_date < (m.month_start + interval '1 month')
                     AND l.entry_date <= p_to
    GROUP BY m.month_start
  ),
  top_expenses AS (
    SELECT a.id, a.name, sum(l.debit - l.credit) AS amount
    FROM lines l JOIN acct a ON a.id = l.account_id
    WHERE l.account_class IN ('expense', 'cogs') AND l.entry_date BETWEEN p_from AND p_to
    GROUP BY a.id, a.name
    HAVING sum(l.debit - l.credit) > 0
    ORDER BY amount DESC
  ),
  banks AS (
    SELECT a.id, a.name, a.account_number, a.system_key, a.bank_balance,
           COALESCE((SELECT sum(l.debit - l.credit) FROM lines l WHERE l.account_id = a.id AND l.entry_date <= p_to), 0) AS book_balance,
           (SELECT max(bt.transaction_date) FROM public.bank_transactions bt WHERE bt.account_id = a.id AND bt.is_reconciled) AS last_reconciled,
           (SELECT count(*) FROM public.bank_transactions bt WHERE bt.account_id = a.id AND NOT bt.is_reconciled) AS unreviewed
    FROM acct a WHERE a.is_cash
  ),
  recent AS (
    SELECT e.id, e.entry_number, e.entry_date, e.description, e.source_type, e.status, e.reverses_entry_id,
           (SELECT COALESCE(sum(debit), 0) FROM public.journal_entry_lines x WHERE x.journal_entry_id = e.id) AS amount
    FROM public.journal_entries e
    WHERE e.business_id = p_business_id AND e.status IN ('posted', 'voided')
    ORDER BY e.entry_date DESC, e.entry_seq DESC NULLS LAST, e.created_at DESC
    LIMIT 10
  ),
  inv AS (
    SELECT
      count(*) FILTER (WHERE status NOT IN ('draft', 'cancelled', 'paid')) AS open_count,
      COALESCE(sum(amount - COALESCE(amount_paid, 0)) FILTER (WHERE status NOT IN ('draft', 'cancelled', 'paid')), 0) AS open_total,
      count(*) FILTER (WHERE status NOT IN ('draft', 'cancelled', 'paid') AND due_date < CURRENT_DATE) AS overdue_count,
      COALESCE(sum(amount - COALESCE(amount_paid, 0)) FILTER (WHERE status NOT IN ('draft', 'cancelled', 'paid') AND due_date < CURRENT_DATE), 0) AS overdue_total
    FROM public.invoices WHERE user_id = v_owner
  ),
  bill AS (
    SELECT
      count(*) FILTER (WHERE status IN ('pending', 'overdue')) AS open_count,
      COALESCE(sum(amount) FILTER (WHERE status IN ('pending', 'overdue')), 0) AS open_total,
      count(*) FILTER (WHERE status IN ('pending', 'overdue') AND due_date <= CURRENT_DATE + 7) AS due_soon_count,
      COALESCE(sum(amount) FILTER (WHERE status IN ('pending', 'overdue') AND due_date <= CURRENT_DATE + 7), 0) AS due_soon_total
    FROM public.bills WHERE user_id = v_owner
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'compare_from', p_compare_from, 'compare_to', p_compare_to),
    'kpis', (SELECT jsonb_build_object(
               'income', income, 'expenses', expenses, 'net_profit', income - expenses, 'cash', cash,
               'compare', CASE WHEN p_compare_from IS NULL THEN NULL ELSE jsonb_build_object(
                 'income', cmp_income, 'expenses', cmp_expenses, 'net_profit', cmp_income - cmp_expenses, 'cash', cmp_cash) END,
               'accounts_receivable', ar, 'accounts_payable', ap, 'has_ledger_activity', line_count > 0)
             FROM pl),
    'monthly', (SELECT jsonb_agg(jsonb_build_object('month', to_char(month_start, 'YYYY-MM'),
                                                    'income', income, 'expenses', expenses) ORDER BY month_start)
                FROM monthly),
    'top_expenses', (SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id', id, 'name', name, 'amount', amount) ORDER BY amount DESC, name), '[]'::jsonb)
                     FROM (SELECT * FROM top_expenses ORDER BY amount DESC, name LIMIT 6) t),
    'other_expenses', (SELECT COALESCE(sum(amount), 0) FROM (SELECT amount FROM top_expenses ORDER BY amount DESC, name OFFSET 6) t),
    'bank_accounts', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'account_id', id, 'name', name, 'account_number', account_number, 'is_undeposited', system_key = 'undeposited_funds',
                        'book_balance', book_balance, 'bank_balance', bank_balance,
                        'last_reconciled', last_reconciled, 'unreviewed', unreviewed) ORDER BY system_key NULLS FIRST, name), '[]'::jsonb)
                      FROM banks),
    'recent', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'entry_id', id, 'entry_number', entry_number, 'entry_date', entry_date, 'memo', description,
                 'source_type', source_type, 'status', status, 'is_reversal', reverses_entry_id IS NOT NULL, 'amount', amount)
                 ORDER BY entry_date DESC, entry_number DESC), '[]'::jsonb) FROM recent),
    'owed', (SELECT jsonb_build_object(
               'invoices_open_count', i.open_count, 'invoices_open_total', i.open_total,
               'invoices_overdue_count', i.overdue_count, 'invoices_overdue_total', i.overdue_total,
               'bills_open_count', b.open_count, 'bills_open_total', b.open_total,
               'bills_due_soon_count', b.due_soon_count, 'bills_due_soon_total', b.due_soon_total)
             FROM inv i, bill b),
    'tasks', jsonb_build_object(
      'unreviewed_bank_lines', (SELECT COALESCE(sum(unreviewed), 0) FROM banks),
      'stale_reconciliations', (SELECT count(*) FROM banks
                                WHERE NOT (system_key IS NOT DISTINCT FROM 'undeposited_funds')
                                  AND unreviewed > 0
                                  AND (last_reconciled IS NULL OR last_reconciled < CURRENT_DATE - 45)),
      'overdue_invoices', (SELECT overdue_count FROM inv),
      'bills_due_soon', (SELECT due_soon_count FROM bill),
      'draft_entries', (SELECT count(*) FROM public.journal_entries WHERE business_id = p_business_id AND status = 'draft')
    ),
    -- Activity recorded in older single-entry screens that is not in the ledger yet.
    'not_in_ledger', jsonb_build_object(
      'transactions', (SELECT count(*) FROM public.transactions WHERE user_id = v_owner),
      'bills', (SELECT open_count FROM bill)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.business_dashboard(UUID, DATE, DATE, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.business_dashboard(UUID, DATE, DATE, DATE, DATE) TO authenticated;

-- -----------------------------------------------------------------------------
-- Permission set (blueprint "Permission matrix")
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_permissions(p_business_id UUID)
RETURNS TEXT[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_lead BOOLEAN;
  v_toggles JSONB;
  v_all TEXT[] := ARRAY[
    'dashboard.view', 'reports.view', 'reports.export',
    'bank.categorize', 'bank.connect', 'bank.reconcile', 'bank.reconcile.undo',
    'sales.create', 'expenses.create', 'transactions.edit_posted',
    'journal.create', 'accounts.manage', 'periods.lock',
    'contacts.manage', 'tax.manage', 'documents.manage', 'audit.view',
    'business.users.manage', 'subscription.manage'];
  -- Client defaults (◐ on); toggles in client_toggles can switch any
  -- toggleable permission on or off.
  v_client_default TEXT[] := ARRAY[
    'dashboard.view', 'reports.view', 'reports.export', 'bank.categorize', 'bank.connect',
    'sales.create', 'expenses.create', 'contacts.manage', 'documents.manage'];
  v_client_toggleable TEXT[] := ARRAY[
    'reports.export', 'bank.categorize', 'bank.reconcile', 'sales.create', 'expenses.create',
    'transactions.edit_posted', 'accounts.manage', 'contacts.manage'];
  v_result TEXT[];
  k TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN ARRAY[]::TEXT[];
  END IF;
  SELECT role, is_lead_accountant, client_toggles INTO v_role, v_lead, v_toggles
  FROM public.business_members WHERE business_id = p_business_id AND user_id = auth.uid();

  IF v_role IS NULL THEN
    RETURN ARRAY[]::TEXT[];
  ELSIF v_role IN ('owner', 'admin') THEN
    RETURN v_all;
  ELSIF v_role = 'accountant' THEN
    v_result := array_remove(array_remove(v_all, 'subscription.manage'), 'business.users.manage');
    IF v_lead THEN v_result := v_result || 'business.users.manage'; END IF;
    RETURN v_result;
  ELSIF v_role = 'staff' THEN
    RETURN ARRAY['dashboard.view', 'reports.view'];
  ELSE -- client
    v_result := v_client_default;
    FOREACH k IN ARRAY v_client_toggleable LOOP
      IF v_toggles ? k THEN
        IF (v_toggles->>k)::boolean THEN
          IF NOT k = ANY (v_result) THEN v_result := v_result || k; END IF;
        ELSE
          v_result := array_remove(v_result, k);
        END IF;
      END IF;
    END LOOP;
    RETURN v_result;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.my_permissions(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_permissions(UUID) TO authenticated;
