import type { Router, Request, Response } from 'express'
import { runQuery } from '../db/client'
import { getAuthUserFromRequest } from './session'
import { classifyPurchaseMode } from '../products/purchaseMode'
import { stockFieldsFromRow } from '../products/inventory'

type Money = { amount: string; currencyCode: string }

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

function mapSavedProductRow(row: {
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
  return {
    id: String(row.id),
    handle: row.handle,
    title: row.title,
    descriptionHtml: row.description_html,
    vendor: row.vendor,
    productType: row.product_type,
    featuredImageUrl,
    images,
    price: toMoney(row.variant_price, row.variant_currency_code),
    compareAtPrice: toMoney(row.variant_compare_at_price, row.variant_currency_code),
    packagePrices,
    purchaseMode: classifyPurchaseMode(row.product_type, packagePrices),
    ...mapProductStock(row),
  }
}

const SAVED_PRODUCT_SELECT = `
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
    v_min.price as variant_price,
    v_min.compare_at_price as variant_compare_at_price,
    v_min.currency_code as variant_currency_code,
    v_max.price as variant_set_price,
    v_max.compare_at_price as variant_set_compare_at_price,
    v_max.currency_code as variant_set_currency_code
  FROM user_saved_products usp
  INNER JOIN products p ON p.id = usp.product_id
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

async function listSavedProductsForUser(userId: string) {
  const result = await runQuery<Parameters<typeof mapSavedProductRow>[0]>(
    `
      ${SAVED_PRODUCT_SELECT}
      WHERE usp.user_id = $1
      ORDER BY usp.created_at DESC
    `,
    [userId],
  )
  return result.rows.map(mapSavedProductRow)
}

export function registerUserSavedProductRoutes(router: Router) {
  router.get('/saved-products', async (req: Request, res: Response) => {
    const auth = await getAuthUserFromRequest(req)
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    try {
      const products = await listSavedProductsForUser(auth.userId)
      return res.status(200).json({ products })
    } catch (error: any) {
      if (error?.code === '42P01') {
        return res.status(503).json({
          error: 'Saved products need a database update on this server.',
        })
      }
      console.error('Failed to list saved products', error)
      return res.status(500).json({ error: 'Unable to load saved products' })
    }
  })

  router.post('/saved-products', async (req: Request, res: Response) => {
    const auth = await getAuthUserFromRequest(req)
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const productId = coerceProductId(req.body?.productId)
    if (!productId) {
      return res.status(400).json({ error: 'productId is required' })
    }
    try {
      const exists = await runQuery<{ id: number }>(
        `SELECT id FROM products WHERE id = $1 AND is_active = true LIMIT 1`,
        [productId],
      )
      if (!exists.rows[0]) {
        return res.status(404).json({ error: 'Product not found' })
      }
      await runQuery(
        `
          INSERT INTO user_saved_products (user_id, product_id)
          VALUES ($1, $2)
          ON CONFLICT (user_id, product_id) DO NOTHING
        `,
        [auth.userId, productId],
      )
      const products = await listSavedProductsForUser(auth.userId)
      return res.status(200).json({ products })
    } catch (error: any) {
      if (error?.code === '42P01') {
        return res.status(503).json({
          error: 'Saved products need a database update on this server.',
        })
      }
      console.error('Failed to save product', error)
      return res.status(500).json({ error: 'Unable to save product' })
    }
  })

  router.delete('/saved-products/:productId', async (req: Request, res: Response) => {
    const auth = await getAuthUserFromRequest(req)
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const productId = coerceProductId(req.params.productId)
    if (!productId) {
      return res.status(400).json({ error: 'Invalid productId' })
    }
    try {
      await runQuery(
        `DELETE FROM user_saved_products WHERE user_id = $1 AND product_id = $2`,
        [auth.userId, productId],
      )
      const products = await listSavedProductsForUser(auth.userId)
      return res.status(200).json({ products })
    } catch (error: any) {
      if (error?.code === '42P01') {
        return res.status(503).json({
          error: 'Saved products need a database update on this server.',
        })
      }
      console.error('Failed to unsave product', error)
      return res.status(500).json({ error: 'Unable to remove saved product' })
    }
  })
}
