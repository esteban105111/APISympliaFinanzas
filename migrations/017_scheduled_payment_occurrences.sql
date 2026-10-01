-- Keep the scheduled occurrence date separate from the date the user actually paid.
-- This lets unpaid monthly bills remain visible in their original month, including
-- after the calendar has advanced to a later month.
ALTER TABLE scheduled_payment_history
  ADD COLUMN IF NOT EXISTS due_date date;

-- Historical records did not store the due occurrence. Preserve them using the
-- actual payment date as the best available approximation.
UPDATE scheduled_payment_history
SET due_date = paid_date
WHERE due_date IS NULL;

ALTER TABLE scheduled_payment_history
  ALTER COLUMN due_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_payment_history_due
  ON scheduled_payment_history(scheduled_payment_id, due_date);
