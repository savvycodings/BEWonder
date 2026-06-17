import type { PoolClient } from 'pg'
import { coinsEarnedFromMerchandiseCents } from './wonderCoins'

export type PaidOrderWonderCoinsRow = {
  id: string
  user_id: string
  currency_code: string
  subtotal_cents: number
  discount_cents: number
  wonder_coins_redeemed: number
  wonder_coins_redeem_settled: boolean
  spend_loyalty_coins_awarded: number | null
}

/**
 * After an order first becomes `paid`, deduct redeemed WonderCoins and credit earn once.
 * Earn: 1 coin per R1 merchandise after discount (shipping excluded).
 * Uses order row flags so retries never double-settle.
 */
export async function settleWonderCoinsForPaidOrder(
  client: PoolClient,
  order: PaidOrderWonderCoinsRow,
): Promise<void> {
  const { id: orderId, user_id: userId, currency_code: currencyCode } = order
  const subtotalCents = Math.max(0, Math.floor(order.subtotal_cents || 0))
  const discountCents = Math.max(0, Math.floor(order.discount_cents || 0))
  const redeemPoints = Math.max(0, Math.floor(order.wonder_coins_redeemed || 0))

  if (currencyCode !== 'ZAR') return

  if (redeemPoints > 0 && !order.wonder_coins_redeem_settled) {
    const deducted = await client.query<{ wonder_coins: number }>(
      `
        UPDATE users
        SET wonder_coins = wonder_coins - $2, updated_at = NOW()
        WHERE id::text = $1
          AND wonder_coins >= $2
        RETURNING wonder_coins
      `,
      [userId, redeemPoints],
    )
    if (deducted.rows[0]) {
      await client.query(
        `
          UPDATE orders
          SET wonder_coins_redeem_settled = TRUE, updated_at = NOW()
          WHERE id = $1::uuid
            AND wonder_coins_redeem_settled = FALSE
        `,
        [orderId],
      )
    }
  }

  const merchandiseAfterDiscount = Math.max(0, subtotalCents - discountCents)
  const coinsToEarn = coinsEarnedFromMerchandiseCents(merchandiseAfterDiscount)

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
    [orderId, coinsToEarn],
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
      [userId, coins],
    )
  }
}

/** @deprecated Use settleWonderCoinsForPaidOrder */
export async function applySpendLoyaltyForNewlyPaidOrder(
  client: PoolClient,
  params: {
    orderId: string
    userId: string
    currencyCode: string
    totalCents: number
  },
): Promise<void> {
  const row = await client.query<PaidOrderWonderCoinsRow>(
    `
      SELECT
        id,
        user_id,
        currency_code,
        subtotal_cents,
        COALESCE(discount_cents, 0)::int AS discount_cents,
        COALESCE(wonder_coins_redeemed, 0)::int AS wonder_coins_redeemed,
        COALESCE(wonder_coins_redeem_settled, FALSE) AS wonder_coins_redeem_settled,
        spend_loyalty_coins_awarded
      FROM orders
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [params.orderId],
  )
  const order = row.rows[0]
  if (!order) return
  await settleWonderCoinsForPaidOrder(client, order)
}
