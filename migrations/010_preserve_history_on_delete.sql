ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_payment_source_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_payment_source_check
    CHECK (
      (account_id IS NOT NULL AND card_id IS NULL)
      OR (account_id IS NULL AND card_id IS NOT NULL)
      OR (account_id IS NULL AND card_id IS NULL)
    );
