import { pool, runQuery } from '../db/client'

const ALLOWED_BIOMES = new Set(['grassland', 'mushroom', 'tropical'])

export const WONDER_JUMP_CHEST_REWARD_COINS = 2

/** TEMP: pickup sets unlock to `NOW()` so hub shows Open immediately. Set false for 6h production timer. */
export const WONDER_JUMP_CHEST_PICKUP_INSTANT_UNLOCK_DEBUG = true

export type WonderJumpProgressPayload = {
  highScore: number
  unlockedBiomes: string[]
  chestUnlocksAt: string | null
}

export type ClaimWonderJumpChestResult =
  | { ok: true; wonderCoins: number }
  | {
      ok: false
      status: 400 | 409
      message: string
      chestUnlocksAt?: string | null
      msRemaining?: number
    }

function chestUnlocksAtToIso(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  return null
}

function filterAllowedBiomes(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const x of input) {
    if (typeof x === 'string' && ALLOWED_BIOMES.has(x) && !out.includes(x)) out.push(x)
  }
  return out
}

function parseBiomesFromDb(raw: unknown): string[] {
  const filtered = filterAllowedBiomes(raw)
  if (filtered.length > 0) return filtered
  return ['grassland', 'mushroom', 'tropical']
}

export async function ensureWonderJumpProgressRow(userId: string) {
  await runQuery(
    `
      INSERT INTO user_wonder_jump_progress (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  )
}

export async function getWonderJumpProgressForUser(userId: string): Promise<WonderJumpProgressPayload> {
  await ensureWonderJumpProgressRow(userId)
  const result = await runQuery<{
    high_score: number
    unlocked_biomes: unknown
    wonder_jump_chest_unlocks_at: unknown
  }>(
    `
      SELECT high_score, unlocked_biomes, wonder_jump_chest_unlocks_at
      FROM user_wonder_jump_progress
      WHERE user_id = $1
    `,
    [userId]
  )
  const row = result.rows[0]
  if (!row) {
    return {
      highScore: 0,
      unlockedBiomes: ['grassland', 'mushroom', 'tropical'],
      chestUnlocksAt: null,
    }
  }
  return {
    highScore: row.high_score,
    unlockedBiomes: parseBiomesFromDb(row.unlocked_biomes),
    chestUnlocksAt: chestUnlocksAtToIso(row.wonder_jump_chest_unlocks_at),
  }
}

function mergeBiomes(existing: string[], incoming: string[]): string[] {
  return Array.from(new Set([...existing, ...incoming].filter((b) => ALLOWED_BIOMES.has(b))))
}

export type WonderJumpLeaderboardRow = {
  userId: string
  username: string
  score: number
}

/** Public leaderboard: display scores from `user_wonder_jump_progress` with readable names from `users`. */
export async function getWonderJumpLeaderboard(limit: number): Promise<WonderJumpLeaderboardRow[]> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)))
  const result = await runQuery<{
    user_id: string
    score: number
    username: string
  }>(
    `
      SELECT
        p.user_id,
        p.high_score AS score,
        COALESCE(
          NULLIF(TRIM(u.name), ''),
          SPLIT_PART(COALESCE(u.email, ''), '@', 1),
          'Player'
        ) AS username
      FROM user_wonder_jump_progress p
      LEFT JOIN users u ON u.id::text = p.user_id
      WHERE p.high_score > 0
      ORDER BY p.high_score DESC, p.updated_at ASC
      LIMIT $1
    `,
    [safeLimit]
  )
  return result.rows.map((row) => ({
    userId: row.user_id,
    username: row.username || 'Player',
    score: row.score,
  }))
}

export async function mergeWonderJumpProgressForUser(
  userId: string,
  body: { highScore?: unknown; unlockedBiomes?: unknown }
): Promise<WonderJumpProgressPayload> {
  const current = await getWonderJumpProgressForUser(userId)

  let nextHigh = current.highScore
  if (body.highScore !== undefined && body.highScore !== null) {
    const n = Number(body.highScore)
    if (Number.isFinite(n) && n >= 0) {
      nextHigh = Math.max(current.highScore, Math.floor(n))
    }
  }

  const incomingBiomes = filterAllowedBiomes(body.unlockedBiomes)
  const nextBiomes =
    incomingBiomes.length > 0 ? mergeBiomes(current.unlockedBiomes, incomingBiomes) : current.unlockedBiomes

  await runQuery(
    `
      UPDATE user_wonder_jump_progress
      SET
        high_score = $2,
        unlocked_biomes = $3::jsonb,
        updated_at = NOW()
      WHERE user_id = $1
    `,
    [userId, nextHigh, JSON.stringify(nextBiomes)]
  )

  return getWonderJumpProgressForUser(userId)
}

/** Start chest open timer if none pending. No-op if already pending. */
export async function pickupWonderJumpChestForUser(userId: string): Promise<WonderJumpProgressPayload> {
  await ensureWonderJumpProgressRow(userId)
  if (WONDER_JUMP_CHEST_PICKUP_INSTANT_UNLOCK_DEBUG) {
    await runQuery(
      `
        UPDATE user_wonder_jump_progress
        SET
          wonder_jump_chest_unlocks_at = NOW(),
          updated_at = NOW()
        WHERE user_id = $1
          AND wonder_jump_chest_unlocks_at IS NULL
      `,
      [userId]
    )
  } else {
    await runQuery(
      `
        UPDATE user_wonder_jump_progress
        SET
          wonder_jump_chest_unlocks_at = NOW() + INTERVAL '6 hours',
          updated_at = NOW()
        WHERE user_id = $1
          AND wonder_jump_chest_unlocks_at IS NULL
      `,
      [userId]
    )
  }
  return getWonderJumpProgressForUser(userId)
}

export async function claimWonderJumpChestForUser(userId: string): Promise<ClaimWonderJumpChestResult> {
  await ensureWonderJumpProgressRow(userId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const sel = await client.query<{ wonder_jump_chest_unlocks_at: Date | null }>(
      `
        SELECT wonder_jump_chest_unlocks_at
        FROM user_wonder_jump_progress
        WHERE user_id = $1
        FOR UPDATE
      `,
      [userId]
    )
    const unlock = sel.rows[0]?.wonder_jump_chest_unlocks_at
    if (!unlock) {
      await client.query('ROLLBACK')
      return { ok: false, status: 400, message: 'Nothing to claim' }
    }
    const now = Date.now()
    const unlockMs = new Date(unlock).getTime()
    if (now < unlockMs) {
      await client.query('ROLLBACK')
      return {
        ok: false,
        status: 409,
        message: 'Chest is still opening',
        chestUnlocksAt: new Date(unlock).toISOString(),
        msRemaining: unlockMs - now,
      }
    }
    const coinRow = await client.query<{ wonder_coins: number }>(
      `
        UPDATE users
        SET wonder_coins = wonder_coins + $2, updated_at = NOW()
        WHERE id::text = $1
        RETURNING wonder_coins
      `,
      [userId, WONDER_JUMP_CHEST_REWARD_COINS]
    )
    if (!coinRow.rows[0]) {
      await client.query('ROLLBACK')
      return { ok: false, status: 400, message: 'User not found' }
    }
    await client.query(
      `
        UPDATE user_wonder_jump_progress
        SET wonder_jump_chest_unlocks_at = NULL, updated_at = NOW()
        WHERE user_id = $1
      `,
      [userId]
    )
    await client.query('COMMIT')
    return { ok: true, wonderCoins: coinRow.rows[0].wonder_coins }
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw e
  } finally {
    client.release()
  }
}
