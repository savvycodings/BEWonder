import { pool } from '../db/client'

/**
 * After an order becomes paid, remove ONLY the purchased lines from the account cart.
 * Never wipes the whole cart. Other items stay. The app may still show local cart until
 * reopen; PUT /auth/cart is filtered so purchased lines are not restored.
 */
const SUPPRESS_HOURS = 6

export async function clearCartItemsForPaidOrder(orderId: string): Promise<void> {
  const client = await pool.connect()
  try {
    const orderRes = await client.query<{ user_id: string }>(
      `
        SELECT user_id::text AS user_id
        FROM orders
        WHERE id = $1::uuid AND status = 'paid'
        LIMIT 1
      `,
      [orderId],
    )
    const userId = orderRes.rows[0]?.user_id
    if (!userId) return

    const lines = await client.query<{
      product_id: string | null
      packaging: string | null
      quantity: number
    }>(
      `
        SELECT
          product_id::text AS product_id,
          packaging,
          quantity
        FROM order_line_items
        WHERE order_id = $1::uuid
          AND product_id IS NOT NULL
      `,
      [orderId],
    )

    if (!lines.rows.length) {
      // Do not clear the whole cart — without product ids we cannot safely match lines.
      console.warn('[cart] skip cart clear — paid order has no product_id line items', {
        orderId,
        userId,
      })
      return
    }

    await client.query('BEGIN')
    let touched = 0
    for (const line of lines.rows) {
      const productId = Number(line.product_id)
      if (!Number.isFinite(productId) || productId <= 0) continue
      const packaging =
        String(line.packaging || 'single').trim().toLowerCase() === 'set' ? 'set' : 'single'
      const qty = Math.max(1, Math.floor(Number(line.quantity) || 1))

      const upd = await client.query(
        `
          UPDATE user_cart_items
          SET
            quantity = GREATEST(0, quantity - $4),
            updated_at = NOW()
          WHERE user_id = $1::uuid
            AND product_id = $2::bigint
            AND packaging = $3
        `,
        [userId, productId, packaging, qty],
      )
      touched += upd.rowCount || 0
    }
    await client.query(
      `
        DELETE FROM user_cart_items
        WHERE user_id = $1::uuid
          AND quantity <= 0
      `,
      [userId],
    )
    await client.query('COMMIT')
    console.log('[cart] removed purchased lines only from account cart', {
      orderId,
      userId,
      lineCount: lines.rows.length,
      cartRowsUpdated: touched,
    })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    console.error('[cart] clearCartItemsForPaidOrder failed', orderId, error)
  } finally {
    client.release()
  }
}

/** Drop cart lines that match products on very recent paid orders (stops client PUT restore). */
export async function filterCartLinesAgainstRecentPaidOrders(
  userId: string,
  lines: { productId: number; packaging: 'single' | 'set'; quantity: number }[],
): Promise<{ productId: number; packaging: 'single' | 'set'; quantity: number }[]> {
  if (!lines.length) return lines

  const paid = await pool.query<{
    product_id: string
    packaging: string | null
    quantity: number
  }>(
    `
      SELECT
        oli.product_id::text AS product_id,
        oli.packaging,
        SUM(oli.quantity)::int AS quantity
      FROM orders o
      JOIN order_line_items oli ON oli.order_id = o.id
      WHERE o.user_id = $1::uuid
        AND o.status = 'paid'
        AND o.updated_at > NOW() - ($2::int * INTERVAL '1 hour')
        AND oli.product_id IS NOT NULL
      GROUP BY oli.product_id, oli.packaging
    `,
    [userId, SUPPRESS_HOURS],
  )

  if (!paid.rows.length) return lines

  const suppress = new Map<string, number>()
  for (const row of paid.rows) {
    const packaging =
      String(row.packaging || 'single').trim().toLowerCase() === 'set' ? 'set' : 'single'
    const key = `${row.product_id}:${packaging}`
    suppress.set(key, (suppress.get(key) || 0) + Math.max(0, row.quantity))
  }

  const next: { productId: number; packaging: 'single' | 'set'; quantity: number }[] = []
  for (const line of lines) {
    const key = `${line.productId}:${line.packaging}`
    const blocked = suppress.get(key) || 0
    if (blocked <= 0) {
      next.push(line)
      continue
    }
    const remaining = line.quantity - blocked
    // Consume suppress against this sync line so multiple lines share the budget.
    suppress.set(key, Math.max(0, blocked - line.quantity))
    if (remaining > 0) {
      next.push({ ...line, quantity: remaining })
    }
  }
  return next
}
