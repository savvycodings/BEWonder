import 'dotenv/config'
import { pool } from './client'

const sql = `
CREATE TABLE IF NOT EXISTS community_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_messages_created_at
  ON community_messages (created_at);

CREATE INDEX IF NOT EXISTS idx_community_messages_user_id
  ON community_messages (user_id);
`

async function migrate() {
  await pool.query(sql)
  console.log('community_messages migration applied successfully.')
}

migrate()
  .catch((error) => {
    console.error('community_messages migration failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })

