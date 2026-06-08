import { runQuery } from '../db/client'
import { storefrontRequest } from './storefront'
import { shopifyAdminRequest, getShopifyAdminConfig } from './adminClient'
import {
  buildShippingProfile,
  defaultParcelFromEnv,
  defaultSetParcelFromEnv,
  inferVariantPackaging,
  normalizeWeightToKg,
  pickLockerTier,
} from '../products/shippingDimensions'

type StorefrontVariant = {
  id: string
  title: string
  sku: string | null
  weight: number | null
  weightUnit: string
  availableForSale: boolean
  quantityAvailable: number | null
  price: { amount: string; currencyCode: string } | null
  compareAtPrice: { amount: string; currencyCode: string } | null
  imageUrl: string | null
}

type StorefrontProduct = {
  id: string
  handle: string
  title: string
  descriptionHtml: string | null
  vendor: string | null
  productType: string | null
  tags: string[]
  featuredImageUrl: string | null
  imageUrls: string[]
  variants: StorefrontVariant[]
}

type AdminMeasurement = {
  weightKg: number | null
  lengthCm: number | null
  widthCm: number | null
  heightCm: number | null
  quantityAvailable: number | null
}

const CATALOG_PRODUCTS_QUERY = `
  query SyncCatalogProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          handle
          title
          descriptionHtml
          vendor
          productType
          tags
          featuredImage { url }
          images(first: 20) { edges { node { url } } }
          variants(first: 50) {
            edges {
              node {
                id
                title
                sku
                weight
                weightUnit
                availableForSale
                quantityAvailable
                price { amount currencyCode }
                compareAtPrice { amount currencyCode }
                image { url }
              }
            }
          }
        }
      }
    }
  }
`

const ADMIN_VARIANT_MEASUREMENTS_QUERY = `
  query AdminVariantMeasurements($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        inventoryItem {
          id
          measurement {
            weight { value unit }
          }
          inventoryLevels(first: 10) {
            edges {
              node {
                quantities(names: ["available"]) {
                  quantity
                }
              }
            }
          }
        }
        metafields(first: 12, namespace: "custom") {
          edges {
            node { key value type }
          }
        }
      }
    }
  }
`

function sumAdminAvailableQuantity(
  inventoryItem: {
    inventoryLevels?: {
      edges: { node: { quantities?: { quantity: number }[] } }[]
    } | null
  } | null | undefined
): number | null {
  const edges = inventoryItem?.inventoryLevels?.edges || []
  if (!edges.length) return null
  let sum = 0
  let found = false
  for (const { node } of edges) {
    for (const q of node.quantities || []) {
      if (typeof q.quantity === 'number' && Number.isFinite(q.quantity)) {
        sum += Math.max(0, Math.floor(q.quantity))
        found = true
      }
    }
  }
  return found ? sum : null
}

function parseMetafieldNumber(metafields: { key: string; value: string }[], keys: string[]): number | null {
  for (const key of keys) {
    const hit = metafields.find((m) => m.key === key)
    if (!hit) continue
    const n = Number.parseFloat(String(hit.value).replace(/[^\d.]/g, ''))
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function resolveVariantShipping(
  variant: StorefrontVariant,
  admin: AdminMeasurement | undefined,
  metafields: { key: string; value: string }[]
): {
  lengthCm: number
  widthCm: number
  heightCm: number
  weightKg: number
  lockerTier: string
  packaging: string
} {
  const packaging = inferVariantPackaging(variant.title)
  const fallback = packaging === 'set' ? defaultSetParcelFromEnv() : defaultParcelFromEnv()

  const weightFromStorefront =
    variant.weight && variant.weight > 0
      ? normalizeWeightToKg(variant.weight, variant.weightUnit)
      : null

  const lengthCm =
    admin?.lengthCm ??
    parseMetafieldNumber(metafields, ['length_cm', 'length', 'parcel_length_cm']) ??
    fallback.lengthCm
  const widthCm =
    admin?.widthCm ??
    parseMetafieldNumber(metafields, ['width_cm', 'width', 'parcel_width_cm']) ??
    fallback.widthCm
  const heightCm =
    admin?.heightCm ??
    parseMetafieldNumber(metafields, ['height_cm', 'height', 'parcel_height_cm']) ??
    fallback.heightCm
  const weightKg =
    admin?.weightKg ??
    weightFromStorefront ??
    fallback.weightKg

  const profile = buildShippingProfile({ lengthCm, widthCm, heightCm, weightKg }, fallback)
  return {
    lengthCm: profile.lengthCm,
    widthCm: profile.widthCm,
    heightCm: profile.heightCm,
    weightKg: profile.weightKg,
    lockerTier: profile.lockerTier,
    packaging,
  }
}

async function fetchAllStorefrontProducts(): Promise<StorefrontProduct[]> {
  const out: StorefrontProduct[] = []
  let after: string | null = null

  for (;;) {
    const data: {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        edges: {
          node: {
            id: string
            handle: string
            title: string
            descriptionHtml: string | null
            vendor: string | null
            productType: string | null
            tags: string[]
            featuredImage: { url: string } | null
            images: { edges: { node: { url: string } }[] }
            variants: {
              edges: {
                node: {
                  id: string
                  title: string
                  sku: string | null
                  weight: number | null
                  weightUnit: string
                  availableForSale: boolean
                  quantityAvailable: number | null
                  price: { amount: string; currencyCode: string }
                  compareAtPrice: { amount: string; currencyCode: string } | null
                  image: { url: string } | null
                }
              }[]
            }
          }
        }[]
      }
    } = await storefrontRequest(CATALOG_PRODUCTS_QUERY, { first: 50, after })

    for (const { node } of data.products.edges) {
      out.push({
        id: node.id,
        handle: node.handle,
        title: node.title,
        descriptionHtml: node.descriptionHtml,
        vendor: node.vendor,
        productType: node.productType,
        tags: Array.isArray(node.tags) ? node.tags : [],
        featuredImageUrl: node.featuredImage?.url ?? null,
        imageUrls: node.images.edges.map((e: { node: { url: string } }) => e.node.url).filter(Boolean),
        variants: node.variants.edges.map(({ node: v }) => ({
          id: v.id,
          title: v.title,
          sku: v.sku,
          weight: v.weight,
          weightUnit: v.weightUnit,
          availableForSale: v.availableForSale,
          quantityAvailable: v.quantityAvailable,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          imageUrl: v.image?.url ?? null,
        })),
      })
    }

    if (!data.products.pageInfo.hasNextPage) break
    after = data.products.pageInfo.endCursor
    if (!after) break
  }

  return out
}

async function fetchAdminMeasurements(
  variantIds: string[]
): Promise<
  Map<string, { admin: AdminMeasurement; metafields: { key: string; value: string }[] }>
> {
  const map = new Map<
    string,
    { admin: AdminMeasurement; metafields: { key: string; value: string }[] }
  >()
  if (!getShopifyAdminConfig() || !variantIds.length) return map

  try {
    await shopifyAdminRequest<{ nodes: unknown[] }>(ADMIN_VARIANT_MEASUREMENTS_QUERY, {
      ids: variantIds.slice(0, 1),
    })
  } catch (err) {
    const msg = (err as Error).message || ''
    if (/access denied|read_products|read_inventory/i.test(msg)) {
      console.warn(
        '[shopify sync] Admin API skipped (token needs read_products + read_inventory). Using Storefront weight + size defaults.'
      )
      return map
    }
    console.warn('[shopify sync] Admin enrichment unavailable:', msg)
    return map
  }

  const chunkSize = 50
  for (let i = 0; i < variantIds.length; i += chunkSize) {
    const chunk = variantIds.slice(i, i + chunkSize)
    try {
      const data = await shopifyAdminRequest<{
        nodes: Array<{
          id?: string
          inventoryItem?: {
            measurement?: {
              weight?: { value: number; unit: string } | null
            } | null
            inventoryLevels?: {
              edges: { node: { quantities?: { quantity: number }[] } }[]
            } | null
          } | null
          metafields?: { edges: { node: { key: string; value: string; type: string } }[] }
        } | null>
      }>(ADMIN_VARIANT_MEASUREMENTS_QUERY, { ids: chunk })

      for (const node of data.nodes) {
        if (!node?.id) continue
        const weight = node.inventoryItem?.measurement?.weight
        const metafields = (node.metafields?.edges || []).map((e) => e.node)
        map.set(node.id, {
          admin: {
            weightKg:
              weight && weight.value > 0
                ? normalizeWeightToKg(Number(weight.value), weight.unit)
                : null,
            lengthCm: parseMetafieldNumber(metafields, ['length_cm', 'length', 'parcel_length_cm']),
            widthCm: parseMetafieldNumber(metafields, ['width_cm', 'width', 'parcel_width_cm']),
            heightCm: parseMetafieldNumber(metafields, ['height_cm', 'height', 'parcel_height_cm']),
            quantityAvailable: sumAdminAvailableQuantity(node.inventoryItem),
          },
          metafields,
        })
      }
    } catch (err) {
      console.warn('[shopify sync] Admin enrichment skipped for chunk:', (err as Error).message)
    }
  }

  return map
}

function aggregateProductShipping(
  variantShippings: ReturnType<typeof resolveVariantShipping>[]
): { lengthCm: number; widthCm: number; heightCm: number; weightKg: number; lockerTier: string } {
  const singles = variantShippings.filter((v) => v.packaging !== 'set')
  const pick = singles[0] || variantShippings[0]
  if (!pick) {
    const d = defaultParcelFromEnv()
    return { ...d, lockerTier: pickLockerTier(d.lengthCm, d.widthCm, d.heightCm, d.weightKg) }
  }
  return {
    lengthCm: pick.lengthCm,
    widthCm: pick.widthCm,
    heightCm: pick.heightCm,
    weightKg: pick.weightKg,
    lockerTier: pick.lockerTier,
  }
}

export async function syncShopifyCatalogToDb(): Promise<{ products: number; variants: number }> {
  console.log('[shopify sync] Fetching products from Shopify Storefront…')
  const products = await fetchAllStorefrontProducts()
  console.log(`[shopify sync] Loaded ${products.length} products from Shopify.`)
  const variantIds = products.flatMap((p) => p.variants.map((v) => v.id))
  const adminByVariant = await fetchAdminMeasurements(variantIds)

  let variantCount = 0

  for (const product of products) {
    const variantShippings = product.variants.map((variant) => {
      const adminBlock = adminByVariant.get(variant.id)
      return resolveVariantShipping(
        variant,
        adminBlock?.admin,
        adminBlock?.metafields || []
      )
    })

    const productShipping = aggregateProductShipping(variantShippings)

    const variantStock = product.variants.map((variant) => {
      const adminBlock = adminByVariant.get(variant.id)
      const adminQty = adminBlock?.admin.quantityAvailable
      const storefrontQty =
        typeof variant.quantityAvailable === 'number' ? variant.quantityAvailable : 0
      const quantityAvailable = adminQty != null ? adminQty : storefrontQty
      const availableForSale =
        adminQty != null ? adminQty > 0 : variant.availableForSale
      return { quantityAvailable, availableForSale }
    })

    const totalInventory = variantStock.reduce((sum, v) => sum + v.quantityAvailable, 0)
    const availableForSale = variantStock.some((v) => v.availableForSale)

    const images = [
      ...(product.featuredImageUrl ? [product.featuredImageUrl] : []),
      ...product.imageUrls,
    ].filter((url, idx, arr) => url && arr.indexOf(url) === idx)

    const productResult = await runQuery<{ id: number }>(
      `
        INSERT INTO products (
          shopify_id, handle, title, description_html, vendor, brand, product_type, tags,
          thumbnail_url, images, total_inventory, available_for_sale, is_active,
          length_cm, width_cm, height_cm, weight_kg, locker_tier,
          updated_at, created_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10::jsonb, $11, $12, true,
          $13, $14, $15, $16, $17,
          NOW(), NOW()
        )
        ON CONFLICT (shopify_id) DO UPDATE SET
          handle = EXCLUDED.handle,
          title = EXCLUDED.title,
          description_html = EXCLUDED.description_html,
          vendor = EXCLUDED.vendor,
          brand = EXCLUDED.brand,
          product_type = EXCLUDED.product_type,
          tags = EXCLUDED.tags,
          thumbnail_url = EXCLUDED.thumbnail_url,
          images = EXCLUDED.images,
          total_inventory = EXCLUDED.total_inventory,
          available_for_sale = EXCLUDED.available_for_sale,
          is_active = true,
          length_cm = EXCLUDED.length_cm,
          width_cm = EXCLUDED.width_cm,
          height_cm = EXCLUDED.height_cm,
          weight_kg = EXCLUDED.weight_kg,
          locker_tier = EXCLUDED.locker_tier,
          updated_at = NOW()
        RETURNING id
      `,
      [
        product.id,
        product.handle,
        product.title,
        product.descriptionHtml,
        product.vendor,
        product.vendor,
        product.productType,
        product.tags,
        product.featuredImageUrl,
        JSON.stringify(images),
        totalInventory,
        availableForSale,
        productShipping.lengthCm,
        productShipping.widthCm,
        productShipping.heightCm,
        productShipping.weightKg,
        productShipping.lockerTier,
      ]
    )

    const productDbId = productResult.rows[0]?.id
    if (!productDbId) continue

    for (let i = 0; i < product.variants.length; i++) {
      const variant = product.variants[i]
      const shipping = variantShippings[i]
      const stock = variantStock[i]
      await runQuery(
        `
          INSERT INTO product_variants (
            shopify_id, product_id, title, sku, price, compare_at_price, currency_code,
            available_for_sale, quantity_available, position,
            length_cm, width_cm, height_cm, weight_kg, locker_tier, packaging,
            updated_at, created_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14, $15, $16,
            NOW(), NOW()
          )
          ON CONFLICT (shopify_id) DO UPDATE SET
            product_id = EXCLUDED.product_id,
            title = EXCLUDED.title,
            sku = EXCLUDED.sku,
            price = EXCLUDED.price,
            compare_at_price = EXCLUDED.compare_at_price,
            currency_code = EXCLUDED.currency_code,
            available_for_sale = EXCLUDED.available_for_sale,
            quantity_available = EXCLUDED.quantity_available,
            position = EXCLUDED.position,
            length_cm = EXCLUDED.length_cm,
            width_cm = EXCLUDED.width_cm,
            height_cm = EXCLUDED.height_cm,
            weight_kg = EXCLUDED.weight_kg,
            locker_tier = EXCLUDED.locker_tier,
            packaging = EXCLUDED.packaging,
            updated_at = NOW()
        `,
        [
          variant.id,
          productDbId,
          variant.title,
          variant.sku,
          variant.price?.amount ?? null,
          variant.compareAtPrice?.amount ?? null,
          variant.price?.currencyCode ?? 'ZAR',
          stock.availableForSale,
          stock.quantityAvailable,
          i + 1,
          shipping.lengthCm,
          shipping.widthCm,
          shipping.heightCm,
          shipping.weightKg,
          shipping.lockerTier,
          shipping.packaging,
        ]
      )
      variantCount += 1
    }
  }

  return { products: products.length, variants: variantCount }
}
