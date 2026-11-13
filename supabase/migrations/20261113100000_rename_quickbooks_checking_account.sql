-- =============================================================================
-- Rename the default bank account "QuickBooks Checking Account" to
-- "Business Checking Account".
--
-- The app used to create that account automatically for every new user (the
-- name was copied from QuickBooks' wording). New users now get "Business
-- Checking Account"; this renames the accounts already created.
--
-- Only the name changes: the account id, balances and every transaction and
-- journal line linked to it stay as they are. Users who already have an
-- account called "Business Checking Account" are left alone so no one ends up
-- with two accounts of the same name.
--
-- Safe to run more than once; can be pasted into the Supabase SQL editor.
-- =============================================================================

UPDATE public.chart_of_accounts AS a
SET name = 'Business Checking Account'
WHERE a.name = 'QuickBooks Checking Account'
  AND NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts b
    WHERE b.user_id = a.user_id AND b.name = 'Business Checking Account'
  );
