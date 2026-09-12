ALTER TABLE users
  ADD COLUMN IF NOT EXISTS monthly_income_estimate numeric(14,2)
    CHECK (monthly_income_estimate >= 0);

-- Conserva como valor base el último estimado que el usuario ya haya guardado.
UPDATE users AS u
SET monthly_income_estimate = latest.amount
FROM (
  SELECT DISTINCT ON (user_id) user_id, amount
  FROM income_projections
  ORDER BY user_id, updated_at DESC
) AS latest
WHERE u.id = latest.user_id
  AND u.monthly_income_estimate IS NULL;
