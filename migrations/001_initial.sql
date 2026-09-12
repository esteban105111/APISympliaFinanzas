CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'COP',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK(type IN ('bank','cash','wallet','savings')),
  institution text,
  current_balance numeric(14,2) NOT NULL DEFAULT 0,
  color text NOT NULL DEFAULT '#0F766E',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK(type IN ('income','expense')),
  icon text NOT NULL DEFAULT 'category',
  color text NOT NULL DEFAULT '#0F766E',
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, name, type)
);

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id),
  category_id uuid REFERENCES categories(id),
  type text NOT NULL CHECK(type IN ('income','expense','transfer')),
  amount numeric(14,2) NOT NULL CHECK(amount > 0),
  transaction_date date NOT NULL DEFAULT current_date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  original_amount numeric(14,2) NOT NULL CHECK(original_amount > 0),
  outstanding_amount numeric(14,2) NOT NULL CHECK(outstanding_amount >= 0),
  total_installments integer NOT NULL CHECK(total_installments > 0),
  payment_day integer NOT NULL CHECK(payment_day BETWEEN 1 AND 31),
  start_date date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paid','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE TABLE IF NOT EXISTS debt_installments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debt_id uuid NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  installment_number integer NOT NULL,
  due_date date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK(amount >= 0),
  paid_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','overdue')),
  UNIQUE(debt_id, installment_number)
);

CREATE TABLE IF NOT EXISTS credit_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  issuer text,
  credit_limit numeric(14,2) NOT NULL CHECK(credit_limit >= 0),
  current_debt numeric(14,2) NOT NULL DEFAULT 0 CHECK(current_debt >= 0),
  closing_day integer CHECK(closing_day BETWEEN 1 AND 31),
  due_day integer CHECK(due_day BETWEEN 1 AND 31),
  color text NOT NULL DEFAULT '#1D4ED8',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK(type IN ('real_estate','stock','fund','business','other')),
  target_amount numeric(14,2),
  current_amount numeric(14,2) NOT NULL DEFAULT 0,
  start_date date NOT NULL DEFAULT current_date,
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','sold')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS investment_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id uuid NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL CHECK(amount > 0),
  contribution_date date NOT NULL DEFAULT current_date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id),
  category_id uuid REFERENCES categories(id),
  name text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK(amount > 0),
  payment_day integer NOT NULL CHECK(payment_day IN (15,30)),
  next_due_date date NOT NULL,
  frequency text NOT NULL DEFAULT 'monthly' CHECK(frequency IN ('monthly','once')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS scheduled_payment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_payment_id uuid NOT NULL REFERENCES scheduled_payments(id) ON DELETE CASCADE,
  paid_date date NOT NULL DEFAULT current_date,
  amount numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_debts_user_status ON debts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_scheduled_user_due ON scheduled_payments(user_id, next_due_date);
