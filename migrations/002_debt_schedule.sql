ALTER TABLE debts
  ADD COLUMN IF NOT EXISTS frequency text NOT NULL DEFAULT 'monthly'
    CHECK (frequency IN ('monthly', 'biweekly')),
  ADD COLUMN IF NOT EXISTS first_payment_date date;

UPDATE debts
SET first_payment_date = COALESCE(first_payment_date, start_date)
WHERE first_payment_date IS NULL;

ALTER TABLE debts
  ALTER COLUMN first_payment_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_debt_installments_due
  ON debt_installments(due_date, status);
