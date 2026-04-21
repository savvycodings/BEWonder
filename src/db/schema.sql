CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  profile_picture TEXT,
  shipping_address TEXT,
  payment_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users
ADD COLUMN IF NOT EXISTS profile_picture TEXT;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS shipping_address TEXT;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS payment_method TEXT;

-- user_id as TEXT: live Better Auth `users.id` is often TEXT, not UUID. No FK so this file
-- can run against Neon without type mismatch with the legacy `users` UUID definition above.
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS community_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  body TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE community_messages
ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE community_messages
ALTER COLUMN body DROP NOT NULL;

CREATE TABLE IF NOT EXISTS user_daily_rewards (
  user_id TEXT PRIMARY KEY,
  claimed_count INTEGER NOT NULL DEFAULT 0,
  last_claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  wallet_balance INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_daily_rewards
ADD COLUMN IF NOT EXISTS claimed_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE user_daily_rewards
ADD COLUMN IF NOT EXISTS last_claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE user_daily_rewards
ADD COLUMN IF NOT EXISTS wallet_balance INTEGER NOT NULL DEFAULT 0;

ALTER TABLE user_daily_rewards
ALTER COLUMN claimed_count SET DEFAULT 0;

ALTER TABLE user_daily_rewards
ALTER COLUMN wallet_balance SET DEFAULT 0;

ALTER TABLE user_daily_rewards
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE user_daily_rewards
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_community_messages_created_at ON community_messages (created_at);
CREATE INDEX IF NOT EXISTS idx_user_daily_rewards_last_claimed_at ON user_daily_rewards (last_claimed_at);

-- Orders (Wonderport checkout). user_id is TEXT to match Better Auth `users.id` in production.
-- No FK: repo `users` DDL above may be UUID on empty DBs while Neon uses TEXT — FK would break migrate.
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  reference_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  payment_method TEXT NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'USD',
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  shipping_snapshot_name TEXT,
  shipping_snapshot_line1 TEXT,
  shipping_snapshot_line2 TEXT,
  peach_checkout_id TEXT,
  peach_resource_path TEXT,
  peach_merchant_transaction_id TEXT,
  eft_proof_image_url TEXT,
  eft_customer_note TEXT,
  eft_marked_paid_at TIMESTAMPTZ,
  eft_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT orders_payment_method_chk CHECK (payment_method IN ('peach', 'eft')),
  CONSTRAINT orders_status_chk CHECK (
    status IN (
      'pending_payment',
      'awaiting_proof',
      'paid',
      'failed',
      'cancelled',
      'refunded'
    )
  ),
  CONSTRAINT orders_reference_unique UNIQUE (reference_code)
);

CREATE TABLE IF NOT EXISTS order_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id BIGINT,
  title TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_line_items_qty_chk CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS order_payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status_after TEXT,
  external_event_id TEXT,
  payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_method ON orders (payment_method);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_line_items_order_id ON order_line_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_payment_events_order_id ON order_payment_events (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payment_events_idempotent
  ON order_payment_events (provider, external_event_id)
  WHERE external_event_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Wonderport profile + fulfilment (Better Auth `users` table in production)
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_address2 TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pudo_locker_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pudo_locker_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS eft_bank_account_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS eft_bank_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS eft_bank_account_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS eft_bank_branch TEXT;

-- Order checkout snapshots (delivery choice, contact, customer bank for EFT matching)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_method TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pudo_locker_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pudo_locker_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_eft_account_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_eft_bank_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_eft_account_number TEXT;
