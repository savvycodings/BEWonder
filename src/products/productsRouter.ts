import express from 'express'
import { runQuery } from '../db/client'

const router = express.Router()

type Money = { amount: string; currencyCode: string }

function toMoney(amount: any, currencyCode: any): Money | null {
  if (amount === null || amount === undefined) return null
  return {
    amount: String(amount),
    currencyCode: String(currencyCode || 'USD'),
  }
}

function resolvePackagePrices(
  minAmount: any,
  minCurrency: string | null,
  maxAmount: any,
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

router.get('/products', async (req, res) => {
  const first = Math.max(1, Math.min(50, Number(req.query.first || 20)))
  const q = String(req.query.q || req.query.query || '').trim()

  const whereClause = q ? `WHERE p.title ILIKE $2 OR p.product_type ILIKE $2 OR p.vendor ILIKE $2` : ''
  const values = q ? [first, `%${q}%`] : [first]

  const sql = `
    SELECT
      p.id,
      p.handle,
      p.title,
      p.description_html,
      p.vendor,
      p.product_type,
      p.thumbnail_url,
      p.images,
      v_min.price as variant_price,
      v_min.compare_at_price as variant_compare_at_price,
      v_min.currency_code as variant_currency_code,
      v_max.price as variant_set_price,
      v_max.compare_at_price as variant_set_compare_at_price,
      v_max.currency_code as variant_set_currency_code
    FROM products p
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
    ${whereClause}
    ORDER BY p.updated_at DESC NULLS LAST
    LIMIT $1
  `

  const result = await runQuery<{
    id: number
    handle: string
    title: string
    description_html: string | null
    vendor: string | null
    product_type: string | null
    thumbnail_url: string | null
    images: any
    variant_price: any
    variant_compare_at_price: any
    variant_currency_code: string | null
    variant_set_price: any
    variant_set_compare_at_price: any
    variant_set_currency_code: string | null
  }>(sql, values)

  const products = result.rows.map((row) => {
    const images: string[] = Array.isArray(row.images) ? row.images : row.images?.length ? row.images : []
    const featuredImageUrl = row.thumbnail_url || images[0] || null

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
      packagePrices: resolvePackagePrices(
        row.variant_price,
        row.variant_currency_code,
        row.variant_set_price,
        row.variant_set_currency_code,
      ),
    }
  })

  return res.status(200).json({ products })
})

router.get('/products/:handle', async (req, res) => {
  const handle = String(req.params.handle || '').trim()
  if (!handle) return res.status(400).json({ error: 'handle is required' })

  const result = await runQuery<{
    id: number
    handle: string
    title: string
    description_html: string | null
    vendor: string | null
    product_type: string | null
    thumbnail_url: string | null
    images: any
    variant_price: any
    variant_compare_at_price: any
    variant_currency_code: string | null
    variant_set_price: any
    variant_set_compare_at_price: any
    variant_set_currency_code: string | null
  }>(
    `
      SELECT
        p.id,
        p.handle,
        p.title,
        p.description_html,
        p.vendor,
        p.product_type,
        p.thumbnail_url,
        p.images,
        v_min.price as variant_price,
        v_min.compare_at_price as variant_compare_at_price,
        v_min.currency_code as variant_currency_code,
        v_max.price as variant_set_price,
        v_max.compare_at_price as variant_set_compare_at_price,
        v_max.currency_code as variant_set_currency_code
      FROM products p
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
      WHERE p.handle = $1
      LIMIT 1
    `,
    [handle]
  )

  const row = result.rows[0]
  if (!row) return res.status(404).json({ error: 'Product not found' })

  const images: string[] = Array.isArray(row.images) ? row.images : row.images?.length ? row.images : []
  const featuredImageUrl = row.thumbnail_url || images[0] || null

  return res.status(200).json({
    product: {
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
      packagePrices: resolvePackagePrices(
        row.variant_price,
        row.variant_currency_code,
        row.variant_set_price,
        row.variant_set_currency_code,
      ),
    },
  })
})

export default router

