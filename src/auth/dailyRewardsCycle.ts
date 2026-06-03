/** Seven-day repeating reward amounts (cycle position 1–7). */
export const DAILY_REWARD_AMOUNTS = [1, 2, 3, 4, 5, 6, 7] as const

export const DAILY_REWARD_CYCLE_LENGTH = DAILY_REWARD_AMOUNTS.length

export type DailyRewardItemStatus = 'claimed' | 'unlocked' | 'locked'

export type DailyRewardItemPayload = {
  day: number
  amount: number
  status: DailyRewardItemStatus
}

/** First calendar day label in the current 7-day reward window (1, 8, 15, …). */
export function rewardWindowStartDay(streakDays: number): number {
  if (streakDays <= 0) return 1
  return Math.floor((streakDays - 1) / DAILY_REWARD_CYCLE_LENGTH) * DAILY_REWARD_CYCLE_LENGTH + 1
}

/** Position inside the 7-day coin cycle (1–7) for an absolute day number. */
export function cyclePositionForDay(displayDay: number): number {
  return ((displayDay - 1) % DAILY_REWARD_CYCLE_LENGTH) + 1
}

export function coinAmountForDisplayDay(displayDay: number): number {
  return DAILY_REWARD_AMOUNTS[cyclePositionForDay(displayDay) - 1]
}

/** Cycle slot (1–7) for the next claim given current `claimed_count` in the active window. */
export function cyclePositionForNextClaim(claimedCountInWindow: number): number {
  return (claimedCountInWindow % DAILY_REWARD_CYCLE_LENGTH) + 1
}

export function buildDailyRewardItems(
  streakDays: number,
  claimedCountInWindow: number,
  canClaim: boolean,
): DailyRewardItemPayload[] {
  const windowStart = rewardWindowStartDay(Math.max(0, streakDays))
  const items: DailyRewardItemPayload[] = []

  for (let i = 0; i < DAILY_REWARD_CYCLE_LENGTH; i++) {
    const day = windowStart + i
    const amount = coinAmountForDisplayDay(day)
    let status: DailyRewardItemStatus = 'locked'

    if (claimedCountInWindow > 0 && day < windowStart + claimedCountInWindow) {
      status = 'claimed'
    } else if (day === windowStart + claimedCountInWindow && canClaim) {
      status = 'unlocked'
    }

    items.push({ day, amount, status })
  }

  return items
}
