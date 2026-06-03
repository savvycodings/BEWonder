import type { Pool, PoolClient } from 'pg'

/**
 * One idempotent streak bump per local calendar day in the client's IANA timezone.
 * Run after a successful daily reward claim (not on passive screen views).
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

/**
 * Resets the 7-day reward track and login streak when the user missed at least one full
 * local calendar day (no claim on the prior day, and/or no qualifying login day recorded).
 */
export function reconcileBrokenDailyStreakSql(): string {
  return `
    UPDATE user_daily_rewards d
    SET
      claimed_count = 0,
      login_streak_count = 0,
      login_streak_last_calendar_date = NULL,
      updated_at = NOW()
    WHERE d.user_id = $1
      AND (
        (
          d.login_streak_last_calendar_date IS NOT NULL
          AND d.login_streak_last_calendar_date < ((CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '1 day')::date
        )
        OR (
          d.last_claimed_at IS NOT NULL
          AND (d.last_claimed_at AT TIME ZONE $2)::date < ((CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '1 day')::date
        )
      )
  `
}

/** @deprecated Use reconcileBrokenDailyStreakSql */
export function reconcileBrokenLoginStreakSql(): string {
  return reconcileBrokenDailyStreakSql()
}

export async function runLoginStreakReconcile(
  executor: Pool | PoolClient,
  userId: string,
  timeZone: string,
): Promise<void> {
  await executor.query(reconcileBrokenDailyStreakSql(), [userId, timeZone])
}
