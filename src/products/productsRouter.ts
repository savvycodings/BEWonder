import express from 'express'
import { runQuery } from '../db/client'
import {
  mapProductPayload,
  PRODUCT_SHIPPING_SELECT,
} from './mapProductPayload'

const router = express.Router()

const IN_STOCK_SQL = `
  AND COALESCE(p.available_for_sale, false) = true
  AND COALESCE(p.total_inventory, 0) > 0
`.trim()

/** Home default feed only — brand pages and text search include sold-out items. */
function shouldFilterInStockOnly(req: express.Request): boolean {
  const flag = String(req.query.inStockOnly || '').toLowerCase()
  if (flag === '1' || flag === 'true') return true
  if (flag === '0' || flag === 'false') return false
  const q = String(req.query.q || req.query.query || '').trim()
  return !q
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
        COUNT(p.shopify_id)::int AS product_count
      FROM collections c
      LEFT JOIN collection_products cp
        ON cp.collection_shopify_id = c.shopify_id
      LEFT JOIN products p
        ON p.shopify_id = cp.product_shopify_id
        AND p.is_active = true
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
    tags: string[] | null
    thumbnail_url: string | null
    images: unknown
    available_for_sale: boolean | null
    total_inventory: unknown
    variant_min_price: unknown
    variant_max_price: unknown
    variant_currency_code: string | null
    length_cm: unknown
    width_cm: unknown
    height_cm: unknown
    weight_kg: unknown
    locker_tier: unknown
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
        p.tags,
        p.thumbnail_url,
        p.images,
        p.available_for_sale,
        p.total_inventory,
        v_min.price AS variant_min_price,
        v_max.price AS variant_max_price,
        COALESCE(v_min.currency_code, v_max.currency_code, 'USD') AS variant_currency_code,
        ${PRODUCT_SHIPPING_SELECT}
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
    products: productsResult.rows.map((row) =>
      mapProductPayload({
        ...row,
        variant_price: row.variant_min_price,
        variant_set_price: row.variant_max_price,
        variant_currency_code: row.variant_currency_code,
        variant_set_currency_code: row.variant_currency_code,
      })
    ),
  })
})

router.get('/products', async (req, res) => {
  const first = Math.max(1, Math.min(50, Number(req.query.first || 20)))
  const offset = Math.max(0, Math.min(5000, Number(req.query.offset || 0)))
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

  params.push(offset)
  const offsetIdx = params.length
  params.push(first)
  const limitIdx = params.length

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
      p.available_for_sale,
      p.total_inventory,
      v_min.price as variant_price,
      v_min.compare_at_price as variant_compare_at_price,
      v_min.currency_code as variant_currency_code,
      v_max.price as variant_set_price,
      v_max.compare_at_price as variant_set_compare_at_price,
      v_max.currency_code as variant_set_currency_code,
      ${PRODUCT_SHIPPING_SELECT}
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
    WHERE ${conditions.join(' AND ')}
    ${shouldFilterInStockOnly(req) ? IN_STOCK_SQL : ''}
    ORDER BY ${orderBy}
    LIMIT $${limitIdx}
    OFFSET $${offsetIdx}
  `

  const result = await runQuery(sql, params)
  return res.status(200).json({
    products: result.rows.map((row) => mapProductPayload(row as any)),
  })
})

router.get('/products/:handle', async (req, res) => {
  const handle = String(req.params.handle || '').trim()
  if (!handle) return res.status(400).json({ error: 'handle is required' })

  const result = await runQuery(
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
        v_min.price as variant_price,
        v_min.compare_at_price as variant_compare_at_price,
        v_min.currency_code as variant_currency_code,
        v_max.price as variant_set_price,
        v_max.compare_at_price as variant_set_compare_at_price,
        v_max.currency_code as variant_set_currency_code,
        ${PRODUCT_SHIPPING_SELECT}
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

  const row = result.rows[0] as any
  if (!row) return res.status(404).json({ error: 'Product not found' })

  const variantsResult = await runQuery<{
    shopify_id: string
    title: string
    sku: string | null
    price: unknown
    compare_at_price: unknown
    currency_code: string | null
    packaging: string | null
    length_cm: unknown
    width_cm: unknown
    height_cm: unknown
    weight_kg: unknown
    locker_tier: unknown
  }>(
    `
      SELECT
        shopify_id, title, sku, price, compare_at_price, currency_code, packaging,
        length_cm, width_cm, height_cm, weight_kg, locker_tier
      FROM product_variants
      WHERE product_id = $1
      ORDER BY price ASC NULLS LAST
    `,
    [row.id]
  )

  return res.status(200).json({
    product: {
      ...mapProductPayload(row),
      variants: variantsResult.rows.map((v) => ({
        shopifyId: v.shopify_id,
        title: v.title,
        sku: v.sku,
        packaging: v.packaging,
        price: v.price != null ? { amount: String(v.price), currencyCode: v.currency_code || 'ZAR' } : null,
        compareAtPrice:
          v.compare_at_price != null
            ? { amount: String(v.compare_at_price), currencyCode: v.currency_code || 'ZAR' }
            : null,
        shipping:
          v.length_cm || v.width_cm || v.height_cm || v.weight_kg
            ? {
                lengthCm: Number(v.length_cm) || null,
                widthCm: Number(v.width_cm) || null,
                heightCm: Number(v.height_cm) || null,
                weightKg: Number(v.weight_kg) || null,
                lockerTier: v.locker_tier,
                pudoEligible: v.locker_tier !== 'oversize',
              }
            : null,
      })),
    },
  })
})

export default router
