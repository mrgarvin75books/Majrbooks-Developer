-- support@prm3tax.com is the software's main account; give it admin on signup like the others.
CREATE OR REPLACE FUNCTION public.handle_new_user_app_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NEW.email IN ('support@prm3tax.com', 'support@majrtaxsoftware.com', 'asimmons@prm3tax.com') THEN
    INSERT INTO public.app_user_roles (user_id, role)
    VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.app_user_roles (user_id, role)
    VALUES (NEW.id, 'user');
  END IF;
  RETURN NEW;
END;
$function$;

-- If the account already exists, promote it.
UPDATE public.app_user_roles
SET role = 'admin'
WHERE user_id IN (SELECT id FROM auth.users WHERE email = 'support@prm3tax.com');

INSERT INTO public.app_user_roles (user_id, role)
SELECT id, 'admin'::app_role FROM auth.users
WHERE email = 'support@prm3tax.com'
AND id NOT IN (SELECT user_id FROM public.app_user_roles);
