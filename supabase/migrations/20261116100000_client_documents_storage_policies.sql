-- Storage RLS for the private buckets created by the setup-storage edge function.
-- Neither bucket ever had policies on storage.objects, so every upload (and
-- "New Folder", which writes a .keep placeholder) failed with
-- "new row violates row-level security policy".
--
-- client-documents uses two path layouts:
--   {firm_owner_id}/{client_id}/...   firm staff, from the client profile page
--   {portal_user_id}/...              the client themselves, from the client portal
-- bank-statements uses {user_id}/...

-- Make sure the buckets exist even if the edge function never ran.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('client-documents', 'client-documents', false, 52428800),
       ('bank-statements',  'bank-statements',  false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- True when the signed-in user may touch an object at this path in client-documents.
CREATE OR REPLACE FUNCTION public.can_access_client_document(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  parts TEXT[] := storage.foldername(p_name);
BEGIN
  IF auth.uid() IS NULL OR parts IS NULL OR array_length(parts, 1) IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Own top-level folder (client portal user, or a firm owner's own tree).
  IF parts[1] = auth.uid()::text THEN
    RETURN TRUE;
  END IF;

  -- Firm tree: {owner_id}/{client_id}/... where the user can access that client
  -- and the client really belongs to that owner.
  IF array_length(parts, 1) >= 2
     AND parts[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = parts[2]::uuid
        AND c.user_id::text = parts[1]
    ) AND public.can_access_client(parts[2]::uuid);
  END IF;

  RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.can_access_client_document(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_client_document(TEXT) TO authenticated;

DROP POLICY IF EXISTS "client-documents select" ON storage.objects;
DROP POLICY IF EXISTS "client-documents insert" ON storage.objects;
DROP POLICY IF EXISTS "client-documents update" ON storage.objects;
DROP POLICY IF EXISTS "client-documents delete" ON storage.objects;

CREATE POLICY "client-documents select" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'client-documents' AND public.can_access_client_document(name));

CREATE POLICY "client-documents insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'client-documents' AND public.can_access_client_document(name));

CREATE POLICY "client-documents update" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'client-documents' AND public.can_access_client_document(name))
WITH CHECK (bucket_id = 'client-documents' AND public.can_access_client_document(name));

CREATE POLICY "client-documents delete" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'client-documents' AND public.can_access_client_document(name));

DROP POLICY IF EXISTS "bank-statements select" ON storage.objects;
DROP POLICY IF EXISTS "bank-statements insert" ON storage.objects;
DROP POLICY IF EXISTS "bank-statements update" ON storage.objects;
DROP POLICY IF EXISTS "bank-statements delete" ON storage.objects;

CREATE POLICY "bank-statements select" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'bank-statements' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "bank-statements insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'bank-statements' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "bank-statements update" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'bank-statements' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'bank-statements' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "bank-statements delete" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'bank-statements' AND (storage.foldername(name))[1] = auth.uid()::text);
