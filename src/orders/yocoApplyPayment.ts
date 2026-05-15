import type { PoolClient } from 'pg'
import { applySpendLoyaltyForNewlyPaidOrder } from './orderSpendLoyalty'
import { createTcgShipmentForPaidOrderIfNeeded } from './tcgFulfillment'

export type YocoOrderRow = {
  id: string
  user_id: string
  payment_method: string
  status: string
  total_cents: number
  currency_code: string
}

export async function applyYocoPaymentToOrder(
  client: PoolClient,
  params: {
    order: YocoOrderRow
    success: boolean
    checkoutId: string | null
    paymentId: string | null
    externalId: string
    eventType: string
    payload: unknown
  }
): Promise<{ becamePaid: boolean; status: string }> {
  const { order, success, checkoutId, paymentId, externalId, eventType, payload } = params
  const resolvedStatusAfter = success ? 'paid' : order.status === 'paid' ? 'paid' : 'failed'
  const becamePaid = success && order.status !== 'paid'

  await client.query(
    `
      INSERT INTO order_payment_events (id, order_id, provider, event_type, status_after, external_event_id, payload_json)
      VALUES (gen_random_uuid(), $1, 'yoco', $2, $3, $4, $5::jsonb)
    `,
    [order.id, eventType, resolvedStatusAfter, externalId, JSON.stringify(payload)]
  )

  await client.query(
    `
      UPDATE orders
      SET
        status = CASE
          WHEN $2::text = 'paid' THEN 'paid'
          WHEN $2::text = 'failed' AND status = 'pending_payment' THEN 'failed'
          ELSE status
        END,
        yoco_checkout_id = COALESCE(yoco_checkout_id, $3),
        yoco_payment_id = COALESCE(yoco_payment_id, $4),
        updated_at = NOW()
      WHERE id = $1
    `,
    [order.id, resolvedStatusAfter, checkoutId, paymentId]
  )

  if (becamePaid && success) {
    await applySpendLoyaltyForNewlyPaidOrder(client, {
      orderId: order.id,
      userId: order.user_id,
      currencyCode: order.currency_code,
      totalCents: order.total_cents,
    })
  }

  return { becamePaid, status: resolvedStatusAfter }
}

export async function runYocoPaymentSideEffects(orderId: string, becamePaid: boolean, success: boolean) {
  if (becamePaid && success) {
    void createTcgShipmentForPaidOrderIfNeeded(orderId).catch((err) =>
      console.error('[tcg] create shipment after payment failed', err)
    )
  }
}
