ALTER TABLE credit_cards
  ADD COLUMN IF NOT EXISTS interest_rate_monthly numeric(8,4) NOT NULL DEFAULT 0
    CHECK (interest_rate_monthly >= 0);

ALTER TABLE debts
  ADD COLUMN IF NOT EXISTS credit_card_id uuid REFERENCES credit_cards(id) ON DELETE SET NULL;

ALTER TABLE transactions
  ALTER COLUMN account_id DROP NOT NULL;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS card_id uuid REFERENCES credit_cards(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_payment_source_check'
  ) THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_payment_source_check
      CHECK (
        (account_id IS NOT NULL AND card_id IS NULL)
        OR (account_id IS NULL AND card_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS card_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
  debt_id uuid NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  installments integer NOT NULL CHECK (installments > 0),
  purchase_date date NOT NULL DEFAULT current_date,
  first_payment_date date NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_card_purchases_user_date
  ON card_purchases(user_id, purchase_date DESC);
CREATE INDEX IF NOT EXISTS idx_debts_credit_card
  ON debts(credit_card_id, status);
