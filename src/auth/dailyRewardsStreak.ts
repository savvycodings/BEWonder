import type { Pool, PoolClient } from 'pg'

/**
 * One idempotent streak bump per local calendar day in the client's IANA timezone.
 * `requireSevenDayComplete`: when true, only rows with claimed_count >= 7 are updated (post–7-day track).
 * Params: $1 = user_id, $2 = IANA timezone name (e.g. `Europe/Berlin`).
 */
export function bumpLoginStreakSql(requireSevenDayComplete: boolean): string {
  const sevenFilter = requireSevenDayComplete ? 'AND d.claimed_count >= 7' : ''
  return `
    UPDATE user_daily_rewards d
    SET
      login_streak_count = x.new_cnt,
      login_streak_last_calendar_date = (CURRENT_TIMESTAMP AT TIME ZONE $2)::date,
      updated_at = NOW()
    FROM (
      SELECT
        d2.login_streak_count,
        d2.login_streak_last_calendar_date,
        CASE
          WHEN d2.login_streak_last_calendar_date IS NULL THEN 1
          WHEN d2.login_streak_last_calendar_date = (CURRENT_TIMESTAMP AT TIME ZONE $2)::date THEN d2.login_streak_count
          WHEN d2.login_streak_last_calendar_date = ((CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '1 day')::date
            THEN d2.login_streak_count + 1
          ELSE 1
        END AS new_cnt
      FROM user_daily_rewards d2
      WHERE d2.user_id = $1
    ) x
    WHERE d.user_id = $1
      ${sevenFilter}
      AND (d.login_streak_last_calendar_date IS DISTINCT FROM (CURRENT_TIMESTAMP AT TIME ZONE $2)::date)
  `
}

export async function runLoginStreakBump(
  executor: Pool | PoolClient,
  userId: string,
  requireSevenDayComplete: boolean,
  timeZone: string,
): Promise<void> {
  await executor.query(bumpLoginStreakSql(requireSevenDayComplete), [userId, timeZone])
}
