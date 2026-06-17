import { runQuery } from '../db/client'
import { isProductInStock } from '../products/inventory'
import { buildProductUrl, buildUnsubscribeUrl } from './restockEmail'

const RESTOCK_COOLDOWN_HOURS = 24

export function isProductPurchasable(row: {
  available_for_sale?: boolean | null
  total_inventory?: unknown
}): boolean {
  const totalInventory =
    row.total_inventory == null || row.total_inventory === ''
      ? null
      : Math.max(0, Math.floor(Number(row.total_inventory)))
  return isProductInStock(totalInventory, row.available_for_sale)
}

/**
 * Compare current purchasability to snapshot; on OOS → in-stock, enqueue email notifications.
 * Called after each product upsert during Shopify sync.
 */
export async function checkRestockTransition(productDbId: number): Promise<void> {
  const productRes = await runQuery<{
    id: number
    handle: string
    title: string
    thumbnail_url: string | null
    available_for_sale: boolean | null
    total_inventory: unknown
  }>(
    `
      SELECT id, handle, title, thumbnail_url, available_for_sale, total_inventory
      FROM products
      WHERE id = $1 AND is_active = true
      LIMIT 1
    `,
    [productDbId],
  )
  const product = productRes.rows[0]
  if (!product) return

  const purchasable = isProductPurchasable(product)

  const snapRes = await runQuery<{ is_purchasable: boolean }>(
    `
      SELECT is_purchasable
      FROM product_availability_snapshots
      WHERE product_id = $1
      LIMIT 1
    `,
    [productDbId],
  )
  const previous = snapRes.rows[0]?.is_purchasable

  if (previous === false && purchasable === true) {
    const subscribers = await runQuery<{ user_id: string }>(
      `
        SELECT usp.user_id
        FROM user_saved_products usp
        WHERE usp.product_id = $1
          AND usp.notify_on_restock = true
          AND (
            usp.last_notified_at IS NULL
            OR usp.last_notified_at < NOW() - INTERVAL '${RESTOCK_COOLDOWN_HOURS} hours'
          )
      `,
      [productDbId],
    )

    const productUrl = buildProductUrl(product.handle)
    const unsubscribeUrl = buildUnsubscribeUrl(product.id)
    const payload = {
      title: product.title,
      handle: product.handle,
      thumbnailUrl: product.thumbnail_url,
      productUrl,
      unsubscribeUrl,
    }

    for (const sub of subscribers.rows) {
      await runQuery(
        `
          INSERT INTO notification_outbox (user_id, product_id, channel, status, payload)
          SELECT $1, $2, 'email', 'pending', $3::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM notification_outbox
            WHERE user_id = $1
              AND product_id = $2
              AND channel = 'email'
              AND status = 'pending'
          )
        `,
        [sub.user_id, productDbId, JSON.stringify(payload)],
      )
    }

    if (subscribers.rows.length > 0) {
      console.log(
        `[restock] Enqueued notifications for product ${productDbId} (${product.title}) — ${subscribers.rows.length} subscriber(s)`,
      )
    }
  }

  await runQuery(
    `
      INSERT INTO product_availability_snapshots (product_id, is_purchasable, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (product_id) DO UPDATE SET
        is_purchasable = EXCLUDED.is_purchasable,
        updated_at = NOW()
    `,
    [productDbId, purchasable],
  )
}
