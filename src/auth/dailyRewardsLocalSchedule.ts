import type { Pool, PoolClient } from 'pg'
import type { Request } from 'express'

/** IANA zone from the app (e.g. `Africa/Johannesburg`). Invalid values fall back to `UTC`. */
export function normalizeClientTimeZone(raw: string | undefined | null): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return 'UTC'
  if (s.length > 80 || !/^[A-Za-z0-9_+\/-]+$/.test(s)) return 'UTC'
  return s
}

export function getClientTimeZoneFromRequest(req: Request): string {
  const h = req.headers['x-user-timezone'] ?? req.headers['x-timezone']
  const v = Array.isArray(h) ? h[0] : h
  return normalizeClientTimeZone(typeof v === 'string' ? v : '')
}

export type LocalDailyRewardSchedule = {
  canClaimByLocalCalendar: boolean
  nextUnlockAt: string | null
}

/**
 * One claim per local calendar day (IANA zone from client). `claimed_count === 0` always allows first claim.
 */
export async function fetchLocalDailyRewardSchedule(
  executor: Pool | PoolClient,
  userId: string,
  timeZone: string,
  claimedCount: number,
  maxDays: number,
): Promise<LocalDailyRewardSchedule> {
  const hasCompletedAll = claimedCount >= maxDays
  if (hasCompletedAll) {
    return { canClaimByLocalCalendar: false, nextUnlockAt: null }
  }
  if (claimedCount === 0) {
    return { canClaimByLocalCalendar: true, nextUnlockAt: null }
  }

  const run = async (tz: string): Promise<LocalDailyRewardSchedule> => {
    const r = await executor.query<{
      today_local: string
      last_local: string
      next_local_midnight: Date
    }>(
      `
      SELECT
        (CURRENT_TIMESTAMP AT TIME ZONE $1)::date::text AS today_local,
        (last_claimed_at AT TIME ZONE $1)::date::text AS last_local,
        (
          ((last_claimed_at AT TIME ZONE $1)::date + INTERVAL '1 day')
          ::timestamp AT TIME ZONE $1
        ) AS next_local_midnight
      FROM user_daily_rewards
      WHERE user_id = $2
      LIMIT 1
      `,
      [tz, userId],
    )
    const row = r.rows[0]
    if (!row) {
      return { canClaimByLocalCalendar: false, nextUnlockAt: null }
    }
    const canClaimByLocalCalendar = row.today_local > row.last_local
    const nextUnlockAt =
      canClaimByLocalCalendar || !row.next_local_midnight
        ? null
        : row.next_local_midnight instanceof Date
          ? row.next_local_midnight.toISOString()
          : new Date(String(row.next_local_midnight)).toISOString()
    return { canClaimByLocalCalendar, nextUnlockAt }
  }

  const tz = normalizeClientTimeZone(timeZone)
  try {
    return await run(tz)
  } catch {
    if (tz !== 'UTC') {
      try {
        return await run('UTC')
      } catch {
        return { canClaimByLocalCalendar: claimedCount === 0, nextUnlockAt: null }
      }
    }
    return { canClaimByLocalCalendar: claimedCount === 0, nextUnlockAt: null }
  }
}
