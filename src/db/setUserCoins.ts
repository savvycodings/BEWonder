import 'dotenv/config'
import { pool } from './client'

/**
 * One-shot script: set a user's wonder_coins balance.
 *
 * Usage (from `server/`):
 *   npx tsc && node dist/db/setUserCoins.js "chalyn smitt" 25
 *
 * Matches the user by case-insensitive `full_name`, exact match after trimming
 * whitespace. If multiple users share the name the script aborts and lists them.
 */
async function setUserCoins() {
  const [, , rawName, rawAmount] = process.argv
  const name = String(rawName || '').trim()
  const amount = Number(rawAmount)

  if (!name || !Number.isFinite(amount) || amount < 0) {
    console.error('Usage: node dist/db/setUserCoins.js "<full name>" <amount>')
    process.exitCode = 1
    return
  }

  const matches = await pool.query<{ id: string; name: string; email: string; wonder_coins: number }>(
    `SELECT id::text AS id, name, email, wonder_coins
       FROM users
      WHERE LOWER(TRIM(name)) = LOWER($1)`,
    [name]
  )

  if (matches.rows.length === 0) {
    console.error(`No users matched full_name = ${JSON.stringify(name)}.`)
    process.exitCode = 1
    return
  }

  if (matches.rows.length > 1) {
    console.error(`Multiple users matched ${JSON.stringify(name)}; refine and re-run:`)
    for (const row of matches.rows) {
      console.error(` - ${row.id}  ${row.email}  (currently ${row.wonder_coins} coins)`)
    }
    process.exitCode = 1
    return
  }

  const user = matches.rows[0]
  const updated = await pool.query<{ wonder_coins: number }>(
    `UPDATE users
        SET wonder_coins = $2, updated_at = NOW()
      WHERE id::text = $1
      RETURNING wonder_coins`,
    [user.id, Math.floor(amount)]
  )

  console.log(
    `Set wonder_coins for ${user.name} <${user.email}> from ${user.wonder_coins} to ${updated.rows[0].wonder_coins}.`
  )
}

setUserCoins()
  .catch((error) => {
    console.error('Failed to set user coins:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
