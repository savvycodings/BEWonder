import { pool, runQuery } from '../db/client'

const ALLOWED_BIOMES = new Set(['grassland', 'mushroom', 'tropical', 'space'])

export const WONDER_JUMP_CHEST_REWARD_COINS = 4

/** Debug-only: when true, starting the chest timer unlocks immediately. */
export const WONDER_JUMP_CHEST_PICKUP_INSTANT_UNLOCK_DEBUG = false

export type WonderJumpProgressPayload = {
  highScore: number
  unlockedBiomes: string[]
  bestBiomeReached: string
  chestDocked: boolean
  chestUnlocksAt: string | null
}

const BIOME_RANK: Record<string, number> = {
  grassland: 0,
  mushroom: 1,
  tropical: 2,
  space: 3,
}

function biomeRank(biome: string): number {
  return BIOME_RANK[biome] ?? 0
}

function maxBiomeReached(a: string, b: string): string {
  return biomeRank(a) >= biomeRank(b) ? a : b
}

function parseBestBiomeReached(raw: unknown): string {
  if (typeof raw === 'string' && ALLOWED_BIOMES.has(raw)) return raw
  return 'grassland'
}

/** Matches WonderJump `displayRunScore` bands (high_score is display points, not raw height). */
const DISPLAY_SCORE_AT_TROPICAL = 300
const DISPLAY_SCORE_SPACE_START = 700
const DISPLAY_SCORE_MUSHROOM_START = 130

function accentBiomeFromDisplayScore(displayScore: number): string {
  const s = Math.floor(displayScore)
  if (s >= DISPLAY_SCORE_SPACE_START) return 'space'
  if (s >= DISPLAY_SCORE_AT_TROPICAL) return 'tropical'
  if (s >= DISPLAY_SCORE_MUSHROOM_START) return 'mushroom'
  return 'grassland'
}

function resolveBiomeReached(stored: unknown, displayScore: number): string {
  return maxBiomeReached(parseBestBiomeReached(stored), accentBiomeFromDisplayScore(displayScore))
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

function chestDockedToBool(v: unknown): boolean {
  return v === true
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
  return ['grassland']
}

/** node-pg often returns COUNT/bigint as string — coerce before badge / rewards logic. */
function coercePositiveInt(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
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
    best_biome_reached: unknown
    wonder_jump_chest_docked: unknown
    wonder_jump_chest_unlocks_at: unknown
  }>(
    `
      SELECT
        high_score,
        unlocked_biomes,
        best_biome_reached,
        wonder_jump_chest_docked,
        wonder_jump_chest_unlocks_at
      FROM user_wonder_jump_progress
      WHERE user_id = $1
    `,
    [userId]
  )
  const row = result.rows[0]
  if (!row) {
    return {
      highScore: 0,
      unlockedBiomes: ['grassland'],
      bestBiomeReached: 'grassland',
      chestDocked: false,
      chestUnlocksAt: null,
    }
  }
  return {
    highScore: row.high_score,
    unlockedBiomes: parseBiomesFromDb(row.unlocked_biomes),
    bestBiomeReached: parseBestBiomeReached(row.best_biome_reached),
    chestDocked: chestDockedToBool(row.wonder_jump_chest_docked),
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
  biomeReached: string
}

/** Public leaderboard: display scores from `user_wonder_jump_progress` with readable names from `users`. */
export async function getWonderJumpLeaderboard(limit: number): Promise<WonderJumpLeaderboardRow[]> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)))
  const result = await runQuery<{
    user_id: string
    score: number
    username: string
    biome_reached: string
  }>(
    `
      SELECT
        p.user_id,
        p.high_score AS score,
        COALESCE(
          NULLIF(TRIM(u.name), ''),
          SPLIT_PART(COALESCE(u.email, ''), '@', 1),
          'Player'
        ) AS username,
        COALESCE(NULLIF(TRIM(p.best_biome_reached), ''), 'grassland') AS biome_reached
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
    biomeReached: resolveBiomeReached(row.biome_reached, row.score),
  }))
}

/** 1-based rank using the same ordering as public leaderboard; `null` when user is unranked. */
export async function getWonderJumpLeaderboardRankForUser(userId: string): Promise<number | null> {
  await ensureWonderJumpProgressRow(userId)
  const result = await runQuery<{ rank: number | null }>(
    `
      WITH me AS (
        SELECT high_score, updated_at
        FROM user_wonder_jump_progress
        WHERE user_id = $1
      )
      SELECT CASE
        WHEN me.high_score IS NULL OR me.high_score <= 0 THEN NULL
        ELSE (
          1 + (
            SELECT COUNT(*)
            FROM user_wonder_jump_progress p
            WHERE p.high_score > 0
              AND (
                p.high_score > me.high_score
                OR (p.high_score = me.high_score AND p.updated_at < me.updated_at)
              )
          )
        )
      END AS rank
      FROM me
    `,
    [userId]
  )
  return coercePositiveInt(result.rows[0]?.rank)
}

export async function mergeWonderJumpProgressForUser(
  userId: string,
  body: { highScore?: unknown; unlockedBiomes?: unknown; bestBiomeReached?: unknown }
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

  let nextBest = current.bestBiomeReached
  if (body.bestBiomeReached !== undefined && body.bestBiomeReached !== null) {
    nextBest = maxBiomeReached(current.bestBiomeReached, parseBestBiomeReached(body.bestBiomeReached))
  }
  nextBest = maxBiomeReached(nextBest, accentBiomeFromDisplayScore(nextHigh))

  await runQuery(
    `
      UPDATE user_wonder_jump_progress
      SET
        high_score = $2,
        unlocked_biomes = $3::jsonb,
        best_biome_reached = $4,
        updated_at = NOW()
      WHERE user_id = $1
    `,
    [userId, nextHigh, JSON.stringify(nextBiomes), nextBest]
  )

  return getWonderJumpProgressForUser(userId)
}

/** Place a picked chest in the dock. No-op if a docked/timed chest already exists. */
export async function pickupWonderJumpChestForUser(userId: string): Promise<WonderJumpProgressPayload> {
  await ensureWonderJumpProgressRow(userId)
  await runQuery(
    `
      UPDATE user_wonder_jump_progress
      SET
        wonder_jump_chest_docked = TRUE,
        wonder_jump_chest_unlocks_at = NULL,
        updated_at = NOW()
      WHERE user_id = $1
        AND wonder_jump_chest_docked = FALSE
        AND wonder_jump_chest_unlocks_at IS NULL
    `,
    [userId]
  )
  return getWonderJumpProgressForUser(userId)
}

/** Starts the 6-hour chest timer from docked state. */
export async function startWonderJumpChestTimerForUser(userId: string): Promise<WonderJumpProgressPayload> {
  await ensureWonderJumpProgressRow(userId)
  if (WONDER_JUMP_CHEST_PICKUP_INSTANT_UNLOCK_DEBUG) {
    await runQuery(
      `
        UPDATE user_wonder_jump_progress
        SET wonder_jump_chest_unlocks_at = NOW(), updated_at = NOW()
        WHERE user_id = $1
          AND wonder_jump_chest_docked = TRUE
          AND wonder_jump_chest_unlocks_at IS NULL
      `,
      [userId]
    )
  } else {
    await runQuery(
      `
        UPDATE user_wonder_jump_progress
        SET wonder_jump_chest_unlocks_at = NOW() + INTERVAL '6 hours', updated_at = NOW()
        WHERE user_id = $1
          AND wonder_jump_chest_docked = TRUE
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
    const sel = await client.query<{ wonder_jump_chest_docked: boolean; wonder_jump_chest_unlocks_at: Date | null }>(
      `
        SELECT wonder_jump_chest_docked, wonder_jump_chest_unlocks_at
        FROM user_wonder_jump_progress
        WHERE user_id = $1
        FOR UPDATE
      `,
      [userId]
    )
    const docked = sel.rows[0]?.wonder_jump_chest_docked === true
    const unlock = sel.rows[0]?.wonder_jump_chest_unlocks_at
    if (!docked || !unlock) {
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
        SET wonder_jump_chest_docked = FALSE, wonder_jump_chest_unlocks_at = NULL, updated_at = NOW()
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
