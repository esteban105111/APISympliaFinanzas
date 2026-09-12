ALTER TABLE debts
  ADD COLUMN IF NOT EXISTS interest_rate_monthly numeric(8,4) NOT NULL DEFAULT 0
    CHECK (interest_rate_monthly >= 0),
  ADD COLUMN IF NOT EXISTS total_payable numeric(14,2);

UPDATE debts
SET total_payable = COALESCE(total_payable, outstanding_amount, original_amount)
WHERE total_payable IS NULL;

ALTER TABLE debts
  ALTER COLUMN total_payable SET NOT NULL;
