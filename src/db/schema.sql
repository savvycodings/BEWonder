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

CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS community_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE community_messages
ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE community_messages
ALTER COLUMN body DROP NOT NULL;

CREATE TABLE IF NOT EXISTS user_daily_rewards (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
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
