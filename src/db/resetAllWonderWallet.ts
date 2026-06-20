import 'dotenv/config'
import { pool } from './client'

/**
 * DANGER: Zeros wonder_coins and wonder_gems for ALL users.
 * Irreversible without a DB backup. Also clears legacy user_daily_rewards.wallet_balance.
 *
 * Usage (from `server/`):
 *   pnpm db:reset-wallet
 *
 * Requires DATABASE_URL (production or local). Pass --confirm-all to proceed.
 */
async function resetAllWonderWallet() {
  if (!process.argv.includes('--confirm-all')) {
    console.error('Refusing to run without --confirm-all')
    console.error('Usage: node dist/db/resetAllWonderWallet.js --confirm-all')
    process.exitCode = 1
    return
  }

  const before = await pool.query<{ user_count: string; total_coins: string; total_gems: string }>(
    `
      SELECT
        COUNT(*)::text AS user_count,
        COALESCE(SUM(wonder_coins), 0)::text AS total_coins,
        COALESCE(SUM(wonder_gems), 0)::text AS total_gems
      FROM users
    `,
  )
  const summary = before.rows[0]
  console.log(
    `Before reset: ${summary?.user_count ?? '0'} users, ` +
      `${summary?.total_coins ?? '0'} wonder_coins, ${summary?.total_gems ?? '0'} wonder_gems`,
  )

  const users = await pool.query(
    `
      UPDATE users
      SET wonder_coins = 0, wonder_gems = 0, updated_at = NOW()
    `,
  )
  console.log(`Reset wonder_coins and wonder_gems for ${users.rowCount ?? 0} users.`)

  try {
    const legacy = await pool.query(
      `
        UPDATE user_daily_rewards
        SET wallet_balance = 0
        WHERE wallet_balance IS NOT NULL AND wallet_balance > 0
      `,
    )
    console.log(`Cleared legacy wallet_balance on ${legacy.rowCount ?? 0} daily-reward rows.`)
  } catch (e: any) {
    if (e?.code === '42703' || e?.code === '42P01') {
      console.log('No legacy wallet_balance column/table; skipped.')
    } else {
      throw e
    }
  }
}

resetAllWonderWallet()
  .catch((error) => {
    console.error('Failed to reset Wonder Wallet balances:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
