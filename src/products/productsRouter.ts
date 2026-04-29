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

router.get('/categories', async (_req, res) => {
  const result = await runQuery<{
    shopify_id: string
    handle: string
    title: string
    image_url: string | null
    product_count: number
  }>(
    `
      SELECT
        c.shopify_id,
        c.handle,
        c.title,
        c.image_url,
        COUNT(cp.product_shopify_id)::int AS product_count
      FROM collections c
      LEFT JOIN collection_products cp
        ON cp.collection_shopify_id = c.shopify_id
      GROUP BY c.shopify_id, c.handle, c.title, c.image_url
      ORDER BY c.title ASC
    `
  )

  return res.status(200).json({
    categories: result.rows.map((row) => ({
      shopifyId: row.shopify_id,
      handle: row.handle,
      title: row.title,
      imageUrl: row.image_url,
      productCount: Number(row.product_count) || 0,
    })),
  })
})

router.get('/categories/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').trim()
  if (!slug) return res.status(400).json({ error: 'slug is required' })

  const category = await runQuery<{
    shopify_id: string
    handle: string
    title: string
    image_url: string | null
    description: string | null
  }>(
    `
      SELECT shopify_id, handle, title, image_url, description
      FROM collections
      WHERE handle = $1
      LIMIT 1
    `,
    [slug]
  )
  const cat = category.rows[0]
  if (!cat) return res.status(404).json({ error: 'Category not found' })

  const productsResult = await runQuery<{
    id: number
    shopify_id: string
    handle: string
    title: string
    description_html: string | null
    vendor: string | null
    product_type: string | null
    thumbnail_url: string | null
    images: any
    available_for_sale: boolean | null
    total_inventory: any
    variant_min_price: any
    variant_max_price: any
    variant_currency_code: string | null
  }>(
    `
      SELECT
        p.id,
        p.shopify_id,
        p.handle,
        p.title,
        p.description_html,
        p.vendor,
        p.product_type,
        p.thumbnail_url,
        p.images,
        p.available_for_sale,
        p.total_inventory,
        v_min.price AS variant_min_price,
        v_max.price AS variant_max_price,
        COALESCE(v_min.currency_code, v_max.currency_code, 'USD') AS variant_currency_code
      FROM collections c
      JOIN collection_products cp
        ON cp.collection_shopify_id = c.shopify_id
      JOIN products p
        ON p.shopify_id = cp.product_shopify_id
      LEFT JOIN LATERAL (
        SELECT price, currency_code
        FROM product_variants
        WHERE product_id = p.id
        ORDER BY price ASC NULLS LAST
        LIMIT 1
      ) v_min ON true
      LEFT JOIN LATERAL (
        SELECT price, currency_code
        FROM product_variants
        WHERE product_id = p.id
        ORDER BY price DESC NULLS LAST
        LIMIT 1
      ) v_max ON true
      WHERE c.handle = $1
        AND p.is_active = true
      ORDER BY p.updated_at DESC NULLS LAST
    `,
    [slug]
  )

  return res.status(200).json({
    category: {
      shopifyId: cat.shopify_id,
      handle: cat.handle,
      title: cat.title,
      imageUrl: cat.image_url,
      description: cat.description,
    },
    products: productsResult.rows.map((row) => {
      const images: string[] = Array.isArray(row.images) ? row.images : row.images?.length ? row.images : []
      const featuredImageUrl = row.thumbnail_url || images[0] || null
      return {
        id: String(row.id),
        shopifyId: row.shopify_id,
        handle: row.handle,
        title: row.title,
        descriptionHtml: row.description_html,
        vendor: row.vendor,
        productType: row.product_type,
        featuredImageUrl,
        images,
        availableForSale: row.available_for_sale,
        totalInventory:
          row.total_inventory == null || row.total_inventory === ''
            ? null
            : Number.parseFloat(String(row.total_inventory)),
        minPrice: toMoney(row.variant_min_price, row.variant_currency_code),
        maxPrice: toMoney(row.variant_max_price, row.variant_currency_code),
        price: toMoney(row.variant_min_price, row.variant_currency_code),
        compareAtPrice: null,
        packagePrices: resolvePackagePrices(
          row.variant_min_price,
          row.variant_currency_code,
          row.variant_max_price,
          row.variant_currency_code
        ),
      }
    }),
  })
})

router.get('/products', async (req, res) => {
  const first = Math.max(1, Math.min(50, Number(req.query.first || 20)))
  const q = String(req.query.q || req.query.query || '').trim()
  const sort = String(req.query.sort || '').trim().toLowerCase()
  const collectionHandle = String(req.query.collection || '').trim()

  const orderBy =
    sort === 'new'
      ? 'p.created_at DESC NULLS LAST'
      : 'p.updated_at DESC NULLS LAST'

  const conditions: string[] = ['p.is_active = true']
  const params: unknown[] = []

  if (collectionHandle) {
    params.push(collectionHandle)
    const idx = params.length
    conditions.push(`
      EXISTS (
        SELECT 1 FROM collection_products cp
        JOIN collections c ON c.shopify_id = cp.collection_shopify_id
        WHERE cp.product_shopify_id = p.shopify_id AND c.handle = $${idx}
      )
    `.trim())
  }

  if (q) {
    params.push(`%${q}%`)
    const idx = params.length
    conditions.push(`(
      p.title ILIKE $${idx}
      OR p.product_type ILIKE $${idx}
      OR p.vendor ILIKE $${idx}
      OR COALESCE(array_to_string(p.tags, ' '), '') ILIKE $${idx}
    )`)
  }

  params.push(first)
  const limitIdx = params.length

  const whereSql = `WHERE ${conditions.join(' AND ')}`

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
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT $${limitIdx}
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
  }>(sql, params)

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

