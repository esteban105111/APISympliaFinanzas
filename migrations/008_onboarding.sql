DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'onboarding_completed'
  ) THEN
    ALTER TABLE users
      ADD COLUMN onboarding_completed boolean NOT NULL DEFAULT false;

    -- Solo los usuarios que existían al instalar esta mejora omiten el recorrido.
    UPDATE users SET onboarding_completed = true;
  END IF;
END $$;
