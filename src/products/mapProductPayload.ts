import { classifyPurchaseMode } from './purchaseMode'
import { stockFieldsFromRow } from './inventory'
import { rowToShippingProfile, shippingProfileToApi } from './shippingDimensions'

function mapProductStock(row: { total_inventory?: unknown; available_for_sale?: boolean | null }) {
  const { totalInventory, availableForSale, inStock } = stockFieldsFromRow(row)
  return { totalInventory, availableForSale, inStock }
}

type Money = { amount: string; currencyCode: string }

export function toMoney(amount: unknown, currencyCode: unknown): Money | null {
  if (amount === null || amount === undefined) return null
  return {
    amount: String(amount),
    currencyCode: String(currencyCode || 'USD'),
  }
}

export function resolvePackagePrices(
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

type ProductRowLike = {
  id: number
  shopify_id?: string | null
  handle: string
  title: string
  description_html?: string | null
  vendor?: string | null
  product_type?: string | null
  tags?: string[] | null
  thumbnail_url?: string | null
  images?: unknown
  available_for_sale?: boolean | null
  total_inventory?: unknown
  variant_price?: unknown
  variant_compare_at_price?: unknown
  variant_currency_code?: string | null
  variant_set_price?: unknown
  variant_set_compare_at_price?: unknown
  variant_set_currency_code?: string | null
  length_cm?: unknown
  width_cm?: unknown
  height_cm?: unknown
  weight_kg?: unknown
  locker_tier?: unknown
}

export function mapProductPayload(row: ProductRowLike) {
  const images: string[] = Array.isArray(row.images)
    ? row.images
    : row.images && typeof row.images === 'object' && 'length' in (row.images as object)
      ? (row.images as string[])
      : []
  const featuredImageUrl = row.thumbnail_url || images[0] || null
  const packagePrices = resolvePackagePrices(
    row.variant_price,
    row.variant_currency_code ?? null,
    row.variant_set_price ?? row.variant_price,
    row.variant_set_currency_code ?? row.variant_currency_code ?? null,
  )
  const shippingRow = rowToShippingProfile(row)
  return {
    id: String(row.id),
    ...(row.shopify_id ? { shopifyId: row.shopify_id } : {}),
    handle: row.handle,
    title: row.title,
    descriptionHtml: row.description_html ?? null,
    vendor: row.vendor ?? null,
    productType: row.product_type ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    featuredImageUrl,
    images,
    price: toMoney(row.variant_price, row.variant_currency_code),
    compareAtPrice: toMoney(row.variant_compare_at_price, row.variant_currency_code),
    minPrice: toMoney(row.variant_price, row.variant_currency_code),
    maxPrice: toMoney(row.variant_set_price ?? row.variant_price, row.variant_set_currency_code ?? row.variant_currency_code),
    packagePrices,
    purchaseMode: classifyPurchaseMode(row.product_type, packagePrices),
    shipping: shippingRow ? shippingProfileToApi(shippingRow) : null,
    ...mapProductStock(row),
  }
}

export const PRODUCT_SHIPPING_SELECT = `
  p.length_cm,
  p.width_cm,
  p.height_cm,
  p.weight_kg,
  p.locker_tier
`.trim()
