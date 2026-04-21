import type { PoolClient } from 'pg'

/** Wonder coins granted per full ZAR 100 of order total (including shipping), once per paid order. */
export const WONDER_COINS_PER_ZAR_100 = 5
const ZAR_100_IN_CENTS = 100 * 100

export function wonderCoinsForZarSpendTotal(totalCentsZar: number): number {
  if (!Number.isFinite(totalCentsZar) || totalCentsZar <= 0) return 0
  return Math.floor(totalCentsZar / ZAR_100_IN_CENTS) * WONDER_COINS_PER_ZAR_100
}

/**
 * After an order first becomes `paid`, record loyalty payout (0 if below threshold) and credit the user once.
 * Uses `spend_loyalty_coins_awarded IS NULL` so retries / duplicate events never double-credit.
 */
export async function applySpendLoyaltyForNewlyPaidOrder(
  client: PoolClient,
  params: {
    orderId: string
    userId: string
    currencyCode: string
    totalCents: number
  }
): Promise<void> {
  const { orderId, userId, currencyCode, totalCents } = params
  const coinsToStore =
    currencyCode === 'ZAR' ? wonderCoinsForZarSpendTotal(totalCents) : 0

  const marked = await client.query<{ spend_loyalty_coins_awarded: number }>(
    `
      UPDATE orders
      SET
        spend_loyalty_coins_awarded = $2,
        updated_at = NOW()
      WHERE id = $1::uuid
        AND spend_loyalty_coins_awarded IS NULL
        AND status = 'paid'
      RETURNING spend_loyalty_coins_awarded
    `,
    [orderId, coinsToStore]
  )

  if (!marked.rows[0]) return

  const coins = marked.rows[0].spend_loyalty_coins_awarded
  if (coins > 0) {
    await client.query(
      `
        UPDATE users
        SET wonder_coins = wonder_coins + $2, updated_at = NOW()
        WHERE id::text = $1
      `,
      [userId, coins]
    )
  }
}
