ALTER TABLE scheduled_payments
  ADD COLUMN IF NOT EXISTS notes text;
