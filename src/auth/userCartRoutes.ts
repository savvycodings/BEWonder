import type { Router, Request, Response } from 'express'
import { pool, runQuery } from '../db/client'
import { getAuthUserFromRequest } from './session'
import { classifyPurchaseMode } from '../products/purchaseMode'
import { stockFieldsFromRow } from '../products/inventory'

type Money = { amount: string; currencyCode: string }
type CartPackaging = 'single' | 'set'

function toMoney(amount: unknown, currencyCode: unknown): Money | null {
  if (amount === null || amount === undefined) return null
  return {
    amount: String(amount),
    currencyCode: String(currencyCode || 'USD'),
  }
}

function resolvePackagePrices(
  minAmount: unknown,
  minCurrency: string | null,
  maxAmount: unknown,
  maxCurrency: string | null,
) {
  const single = toMoney(minAmount, minCurrency)
  const set = toMoney(maxAmount, maxCurrency || minCurrency)
  const minNum = Number.parseFloat(String(minAmount))
  const maxNum = Number.parseFloat(String(maxAmount))
  const hasDistinctSetPrice =
    Number.isFinite(minNum) && Number.isFinite(maxNum) && maxNum > minNum
  return {
    single,
    set: hasDistinctSetPrice ? set : null,
  }
}

function mapProductStock(row: { total_inventory?: unknown; available_for_sale?: boolean | null }) {
  const { totalInventory, availableForSale, inStock } = stockFieldsFromRow(row)
  return { totalInventory, availableForSale, inStock }
}

function coerceProductId(raw: unknown): number | null {
  const n = Number.parseInt(String(raw ?? '').trim(), 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function normalizePackaging(raw: unknown): CartPackaging | null {
  const p = String(raw ?? '').trim().toLowerCase()
  if (p === 'single' || p === 'set') return p
  return null
}

function mapCartItemRow(row: {
  id: number
  handle: string
  title: string
  description_html: string | null
  vendor: string | null
  product_type: string | null
  thumbnail_url: string | null
  images: unknown
  available_for_sale: boolean | null
  total_inventory: unknown
  variant_price: unknown
  variant_compare_at_price: unknown
  variant_currency_code: string | null
  variant_set_price: unknown
  variant_set_compare_at_price: unknown
  variant_set_currency_code: string | null
  packaging: string
  quantity: number
}) {
  const images: string[] = Array.isArray(row.images)
    ? (row.images as string[])
    : row.images && typeof row.images === 'object' && 'length' in (row.images as object)
      ? (row.images as string[])
      : []
  const featuredImageUrl = row.thumbnail_url || images[0] || null
  const packagePrices = resolvePackagePrices(
    row.variant_price,
    row.variant_currency_code,
    row.variant_set_price,
    row.variant_set_currency_code,
  )
  const packaging = normalizePackaging(row.packaging) ?? 'single'
  const price =
    packaging === 'set'
      ? packagePrices.set ?? packagePrices.single
      : packagePrices.single
  const displayTitle =
    packaging === 'set' ? `${row.title} (Whole set)` : row.title

  return {
    id: String(row.id),
    handle: row.handle,
    title: displayTitle,
    descriptionHtml: row.description_html,
    vendor: row.vendor,
    productType: row.product_type,
    featuredImageUrl,
    images,
    price,
    compareAtPrice: toMoney(row.variant_compare_at_price, row.variant_currency_code),
    packagePrices,
    purchaseMode: classifyPurchaseMode(row.product_type, packagePrices),
    selectedPackaging: packaging,
    quantity: row.quantity,
    ...mapProductStock(row),
  }
}

const CART_PRODUCT_SELECT = `
  SELECT
    p.id,
    p.handle,
    p.title,
    p.description_html,
    p.vendor,
    p.product_type,
    p.thumbnail_url,
    p.images,
    p.available_for_sale,
    p.total_inventory,
    uci.packaging,
    uci.quantity,
    v_min.price as variant_price,
    v_min.compare_at_price as variant_compare_at_price,
    v_min.currency_code as variant_currency_code,
    v_max.price as variant_set_price,
    v_max.compare_at_price as variant_set_compare_at_price,
    v_max.currency_code as variant_set_currency_code
  FROM user_cart_items uci
  INNER JOIN products p ON p.id = uci.product_id
  LEFT JOIN LATERAL (
    SELECT price, compare_at_price, currency_code
    FROM product_variants
    WHERE product_id = p.id
    ORDER BY price ASC NULLS LAST
    LIMIT 1
  ) v_min ON true
  LEFT JOIN LATERAL (
    SELECT price, compare_at_price, currency_code
    FROM product_variants
    WHERE product_id = p.id
    ORDER BY price DESC NULLS LAST
    LIMIT 1
  ) v_max ON true
`

async function listCartItemsForUser(userId: string) {
  const result = await runQuery<Parameters<typeof mapCartItemRow>[0]>(
    `
      ${CART_PRODUCT_SELECT}
      WHERE uci.user_id = $1
      ORDER BY uci.updated_at DESC
    `,
    [userId],
  )
  return result.rows.map(mapCartItemRow)
}

type CartSyncLine = { productId: number; packaging: CartPackaging; quantity: number }

function parseCartSyncBody(raw: unknown): CartSyncLine[] | null {
  if (!Array.isArray(raw)) return []
  const lines: CartSyncLine[] = []
  for (const entry of raw) {
    const productId = coerceProductId((entry as any)?.productId)
    const packaging = normalizePackaging((entry as any)?.packaging)
    const quantity = Number.parseInt(String((entry as any)?.quantity ?? ''), 10)
    if (!productId || !packaging || !Number.isFinite(quantity) || quantity < 1) {
      return null
    }
    lines.push({ productId, packaging, quantity })
  }
  return lines
}

async function replaceUserCart(userId: string, lines: CartSyncLine[]) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM user_cart_items WHERE user_id = $1`, [userId])
    for (const line of lines) {
      await client.query(
        `
          INSERT INTO user_cart_items (user_id, product_id, packaging, quantity, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
        `,
        [userId, line.productId, line.packaging, line.quantity],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export function registerUserCartRoutes(router: Router) {
  router.get('/cart', async (req: Request, res: Response) => {
    const auth = await getAuthUserFromRequest(req)
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    try {
      const items = await listCartItemsForUser(auth.userId)
      return res.status(200).json({ items })
    } catch (error: any) {
      if (error?.code === '42P01') {
        return res.status(503).json({
          error: 'Cart persistence needs a database update on this server.',
        })
      }
      console.error('Failed to list cart', error)
      return res.status(500).json({ error: 'Unable to load cart' })
    }
  })

  router.put('/cart', async (req: Request, res: Response) => {
    const auth = await getAuthUserFromRequest(req)
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const lines = parseCartSyncBody(req.body?.items)
    if (lines === null) {
      return res.status(400).json({ error: 'Invalid cart items payload' })
    }
    try {
      if (lines.length > 0) {
        const ids = [...new Set(lines.map((l) => l.productId))]
        const exists = await runQuery<{ id: number }>(
          `
            SELECT id FROM products
            WHERE id = ANY($1::bigint[]) AND is_active = true
          `,
          [ids],
        )
        if (exists.rows.length !== ids.length) {
          return res.status(404).json({ error: 'One or more products were not found' })
        }
      }
      await replaceUserCart(auth.userId, lines)
      const items = await listCartItemsForUser(auth.userId)
      return res.status(200).json({ items })
    } catch (error: any) {
      if (error?.code === '42P01') {
        return res.status(503).json({
          error: 'Cart persistence needs a database update on this server.',
        })
      }
      console.error('Failed to update cart', error)
      return res.status(500).json({ error: 'Unable to update cart' })
    }
  })
}
