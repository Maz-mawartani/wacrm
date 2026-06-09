-- Public storage for WhatsApp template header media.
--
-- The upload route writes with the service-role key after authenticating
-- the user, so INSERT/UPDATE/DELETE policies are intentionally omitted.
-- Public read keeps Meta able to fetch header media without signed URLs.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'template-media',
  'template-media',
  TRUE,
  5242880, -- 5 MB default; the upload route raises this per larger PDF if allowed
  ARRAY['image/png', 'image/jpeg', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Template media is publicly readable" ON storage.objects;
CREATE POLICY "Template media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'template-media');
