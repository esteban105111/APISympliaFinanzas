-- Cada movimiento automático queda ligado a su origen. Esto permite eliminar
-- una obligación sin dejar gastos o transferencias huérfanos en los informes.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS debt_id uuid REFERENCES debts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS scheduled_payment_id uuid REFERENCES scheduled_payments(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS investment_id uuid REFERENCES investments(id) ON DELETE CASCADE;

-- Un pago de tarjeta es una transferencia desde una cuenta hacia una tarjeta;
-- por eso necesita ambas referencias. Los demás movimientos conservan las
-- reglas de origen existentes.
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_payment_source_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_payment_source_check
    CHECK (
      (account_id IS NOT NULL AND card_id IS NULL)
      OR (account_id IS NULL AND card_id IS NOT NULL)
      OR (account_id IS NULL AND card_id IS NULL)
      OR (account_id IS NOT NULL AND card_id IS NOT NULL AND type = 'transfer')
    );

CREATE INDEX IF NOT EXISTS idx_transactions_debt ON transactions(debt_id);
CREATE INDEX IF NOT EXISTS idx_transactions_scheduled_payment ON transactions(scheduled_payment_id);
CREATE INDEX IF NOT EXISTS idx_transactions_investment ON transactions(investment_id);

-- Relaciona movimientos históricos generados por la aplicación. Los nuevos
-- registros siempre se guardan con su id de origen desde la API.
UPDATE transactions t
SET debt_id = cp.debt_id
FROM card_purchases cp
JOIN credit_cards cc ON cc.id = cp.card_id
WHERE t.user_id = cp.user_id
  AND t.debt_id IS NULL
  AND t.card_id = cp.card_id
  AND t.transaction_date = cp.purchase_date
  AND t.note = ('Compra con ' || cc.name || ': ' || cp.description);

UPDATE transactions t
SET debt_id = d.id
FROM debts d
WHERE t.user_id = d.user_id
  AND t.debt_id IS NULL
  AND t.note IN ('Cuota de deuda: ' || d.name, 'Pago de tarjeta: ' || d.name);

UPDATE transactions t
SET scheduled_payment_id = p.id
FROM scheduled_payments p
WHERE t.user_id = p.user_id
  AND t.scheduled_payment_id IS NULL
  AND t.note = ('Pago programado: ' || p.name);

UPDATE transactions t
SET investment_id = ic.investment_id
FROM investment_contributions ic
WHERE t.id = ic.transaction_id
  AND t.investment_id IS NULL;
