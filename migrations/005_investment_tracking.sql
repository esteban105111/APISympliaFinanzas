ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS target_date date,
  ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#7C3AED';

ALTER TABLE investment_contributions
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_investment_contributions_date
  ON investment_contributions(investment_id, contribution_date DESC);
