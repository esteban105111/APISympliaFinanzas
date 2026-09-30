CREATE TABLE IF NOT EXISTS notification_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_hash char(64) NOT NULL,
  source text NOT NULL,
  type text NOT NULL CHECK (type IN ('income', 'expense')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  transaction_date date NOT NULL,
  note text NOT NULL,
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'imported', 'dismissed')),
  transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, event_hash)
);

CREATE INDEX IF NOT EXISTS idx_notification_candidates_user_pending
  ON notification_candidates(user_id, created_at DESC)
  WHERE status = 'pending';
