-- Una transferencia entre cuentas conserva un solo movimiento y dos saldos.
-- El destino es opcional para los traslados históricos a tarjetas y metas.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS destination_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;

-- Conserva el historial aunque luego se elimine la cuenta de destino.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS is_account_transfer boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_destination_account_check'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_destination_account_check
      CHECK (
        destination_account_id IS NULL
        OR (
          type = 'transfer'
          AND card_id IS NULL
          AND (account_id IS NULL OR account_id <> destination_account_id)
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transactions_account_transfer
  ON transactions(user_id, transaction_date DESC, created_at DESC)
  WHERE is_account_transfer;
