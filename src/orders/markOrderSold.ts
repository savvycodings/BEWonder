import { pool } from '../db/client'
import { decreaseShopifyInventoryForSale } from '../shopify/inventoryAdjust'
import { getShopifyAdminConfig } from '../shopify/adminClient'
import { resolveOrderLineVariantShopifyIds } from './orderLineVariants'

export type MarkOrderSoldResult = {
  ok: boolean
  alreadySold?: boolean
  soldAt?: string
  message: string
  shopifyAdjusted?: number
  shopifySkipped?: boolean
}

export async function markOrderSold(orderId: string): Promise<MarkOrderSoldResult> {
  const lineRefs = await resolveOrderLineVariantShopifyIds(orderId)

  const shopifyLines = lineRefs
    .filter((l) => l.variantShopifyId)
    .map((l) => ({
      variantShopifyId: l.variantShopifyId as string,
      quantity: l.quantity,
    }))

  let shopifyResult: { adjusted: number; skipped: number } | null = null
  if (shopifyLines.length && getShopifyAdminConfig()) {
    shopifyResult = await decreaseShopifyInventoryForSale(shopifyLines)
  } else if (shopifyLines.length && !getShopifyAdminConfig()) {
    throw new Error(
      'Shopify Admin is not configured. Set SHOPIFY_ADMIN_ACCESS_TOKEN (shpat_… with write_inventory) before marking sold.'
    )
  }

  const qtyByProduct = new Map<number, number>()
  for (const line of lineRefs) {
    qtyByProduct.set(line.productId, (qtyByProduct.get(line.productId) || 0) + line.quantity)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const ores = await client.query<{ id: string; status: string; sold_at: string | null }>(
      `
        SELECT id, status, sold_at
        FROM orders
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [orderId]
    )
    const order = ores.rows[0]
    if (!order) {
      await client.query('ROLLBACK')
      return { ok: false, message: 'Order not found' }
    }
    if (order.status !== 'paid') {
      await client.query('ROLLBACK')
      return { ok: false, message: 'Order must be paid before marking as sold.' }
    }
    if (order.sold_at) {
      await client.query('ROLLBACK')
      return {
        ok: true,
        alreadySold: true,
        soldAt: order.sold_at,
        message: 'Order was already marked sold.',
      }
    }

    for (const [productId, qty] of qtyByProduct) {
      await client.query(
        `
          UPDATE products
          SET
            total_inventory = GREATEST(0, COALESCE(total_inventory, 0) - $2),
            available_for_sale = CASE
              WHEN GREATEST(0, COALESCE(total_inventory, 0) - $2) > 0 THEN available_for_sale
              ELSE false
            END,
            updated_at = NOW()
          WHERE id = $1
        `,
        [productId, qty]
      )

      await client.query(
        `
          UPDATE product_variants
          SET
            quantity_available = GREATEST(0, COALESCE(quantity_available, 0) - $2),
            available_for_sale = CASE
              WHEN GREATEST(0, COALESCE(quantity_available, 0) - $2) > 0 THEN available_for_sale
              ELSE false
            END,
            updated_at = NOW()
          WHERE product_id = $1
        `,
        [productId, qty]
      )
    }

    const upd = await client.query<{ sold_at: string }>(
      `
        UPDATE orders
        SET sold_at = NOW(), updated_at = NOW()
        WHERE id = $1::uuid AND status = 'paid' AND sold_at IS NULL
        RETURNING sold_at
      `,
      [orderId]
    )
    if (!upd.rows[0]) {
      await client.query('ROLLBACK')
      return { ok: false, message: 'Could not mark sold (state changed).' }
    }

    await client.query(
      `
        INSERT INTO order_payment_events (order_id, provider, event_type, status_after, payload_json)
        VALUES ($1, 'admin', 'mark_sold', 'sold', $2::jsonb)
      `,
      [
        orderId,
        JSON.stringify({
          soldAt: upd.rows[0].sold_at,
          inventoryAdjusted: qtyByProduct.size > 0,
          productIds: [...qtyByProduct.keys()],
          shopifyAdjusted: shopifyResult?.adjusted ?? 0,
        }),
      ]
    )

    await client.query('COMMIT')

    const shopifyMsg =
      shopifyResult != null
        ? ` Shopify stock reduced (${shopifyResult.adjusted} variant${shopifyResult.adjusted === 1 ? '' : 's'}).`
        : ''

    return {
      ok: true,
      soldAt: upd.rows[0].sold_at,
      shopifyAdjusted: shopifyResult?.adjusted,
      shopifySkipped: !shopifyLines.length,
      message: `Order marked as sold. Local and Shopify stock updated.${shopifyMsg}`,
    }
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
