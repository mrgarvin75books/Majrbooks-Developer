-- Fix: new signups were showing the "subscription plan" paywall instead of getting
-- their 14-day free trial. Root cause: trial_ends_at was only ever set by a client-side
-- UPDATE (AuthContext.startFreeTrial) that runs right after supabase.auth.signUp(). When
-- email confirmation is required, signUp() returns no session, so that UPDATE is silently
-- rejected by the profiles RLS policy ("TO authenticated"), leaving trial_ends_at NULL
-- forever. The client-invite flow (AcceptClientInvite.tsx) never attempted this at all.
--
-- Fix by setting trial_ends_at directly in the handle_new_user() trigger, which runs
-- SECURITY DEFINER at row-insert time and is unaffected by session/RLS timing — every
-- new auth.users row (regular signup, client invite, team invite) reliably gets a trial.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, trial_ends_at)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.email,
    now() + interval '14 days'
  );

  -- Insert default categories
  INSERT INTO public.categories (name, type, color, icon, user_id)
  VALUES
    ('Salary', 'income', '#10b981', 'Briefcase', NEW.id),
    ('Business', 'income', '#3b82f6', 'TrendingUp', NEW.id),
    ('Investment', 'income', '#8b5cf6', 'PiggyBank', NEW.id),
    ('Office', 'expense', '#ef4444', 'Building', NEW.id),
    ('Marketing', 'expense', '#f59e0b', 'Megaphone', NEW.id),
    ('Travel', 'expense', '#06b6d4', 'Plane', NEW.id),
    ('Utilities', 'expense', '#ec4899', 'Zap', NEW.id);

  RETURN NEW;
END;
$$;
