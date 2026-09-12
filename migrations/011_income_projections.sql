CREATE TABLE IF NOT EXISTS income_projections (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month),
  CHECK (month = date_trunc('month', month)::date)
);

CREATE INDEX IF NOT EXISTS idx_income_projections_user_month
  ON income_projections(user_id, month DESC);
