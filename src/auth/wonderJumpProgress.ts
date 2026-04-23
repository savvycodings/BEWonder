import { runQuery } from '../db/client'

const ALLOWED_BIOMES = new Set(['grassland', 'mushroom', 'tropical'])

export type WonderJumpProgressPayload = {
  highScore: number
  unlockedBiomes: string[]
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
  const result = await runQuery<{ high_score: number; unlocked_biomes: unknown }>(
    `
      SELECT high_score, unlocked_biomes
      FROM user_wonder_jump_progress
      WHERE user_id = $1
    `,
    [userId]
  )
  const row = result.rows[0]
  if (!row) {
    return { highScore: 0, unlockedBiomes: ['grassland', 'mushroom', 'tropical'] }
  }
  return {
    highScore: row.high_score,
    unlockedBiomes: parseBiomesFromDb(row.unlocked_biomes),
  }
}

function mergeBiomes(existing: string[], incoming: string[]): string[] {
  return Array.from(new Set([...existing, ...incoming].filter((b) => ALLOWED_BIOMES.has(b))))
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

  return { highScore: nextHigh, unlockedBiomes: nextBiomes }
}
