-- ============================================================
-- ADMIN USER MANAGEMENT
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);

-- Bootstrap existing installs: if no admin exists yet, promote the
-- oldest profile so the Settings > Users panel has an initial owner.
UPDATE profiles
SET role = 'admin'
WHERE id = (
  SELECT id
  FROM profiles
  ORDER BY created_at ASC, id ASC
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1
  FROM profiles
  WHERE role = 'admin'
);

-- Keep the signup trigger aligned for fresh installs and recovery
-- cases where all admin profiles were removed outside the app.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  profile_role TEXT := 'user';
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE role = 'admin'
  ) THEN
    profile_role := 'admin';
  END IF;

  INSERT INTO public.profiles (user_id, full_name, email, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.email, ''),
    profile_role
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
