import type { PoolClient } from 'pg'
import { runQuery } from '../db/client'

export type OrderLineVariantRef = {
  productId: number
  quantity: number
  packaging: string
  variantShopifyId: string | null
}

/** Resolve Shopify variant GID for each order line (matches packaging → variant logic used for shipping). */
export async function resolveOrderLineVariantShopifyIds(
  orderId: string,
  client?: PoolClient
): Promise<OrderLineVariantRef[]> {
  const sql = `
    SELECT
      oli.product_id,
      oli.quantity::int AS quantity,
      COALESCE(oli.packaging, 'single') AS packaging,
      v.shopify_id AS variant_shopify_id
    FROM order_line_items oli
    LEFT JOIN LATERAL (
      SELECT shopify_id
      FROM product_variants pv
      WHERE pv.product_id = oli.product_id
        AND (
          (COALESCE(oli.packaging, 'single') = 'set' AND pv.packaging = 'set')
          OR (COALESCE(oli.packaging, 'single') <> 'set' AND COALESCE(pv.packaging, 'standard') <> 'set')
        )
      ORDER BY
        CASE WHEN COALESCE(oli.packaging, 'single') = 'set' THEN pv.price END DESC NULLS LAST,
        pv.price ASC NULLS LAST
      LIMIT 1
    ) v ON oli.product_id IS NOT NULL
    WHERE oli.order_id = $1::uuid
      AND oli.product_id IS NOT NULL
    ORDER BY oli.created_at ASC
  `
  const result = client
    ? await client.query<{
        product_id: number
        quantity: number
        packaging: string
        variant_shopify_id: string | null
      }>(sql, [orderId])
    : await runQuery<{
        product_id: number
        quantity: number
        packaging: string
        variant_shopify_id: string | null
      }>(sql, [orderId])

  return result.rows.map((r) => ({
    productId: Number(r.product_id),
    quantity: Math.max(1, Math.floor(Number(r.quantity) || 1)),
    packaging: r.packaging,
    variantShopifyId: r.variant_shopify_id,
  }))
}
