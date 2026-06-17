import { runQuery } from '../db/client'
import { moneyStringToCents } from './money'
import { isProductInStock, parseTotalInventory, stockFieldsFromRow } from '../products/inventory'
import {
  isValidPudoLockerTier,
  orderHasWholeSetLine,
  qualifiesForFreeDeliveryZar,
  shippingCentsForOrder,
  type PudoLockerTier,
} from './pudoLockerPricing'
import { quoteOrderWonderCoins } from './wonderCoins'

export type LineInput = { productId: string; quantity: number; packaging?: 'single' | 'set' }

export type OrderLine = {
  productId: number
  title: string
  unitCents: number
  currency: string
  qty: number
  lineTotal: number
  imageUrl: string | null
  packaging: 'single' | 'set'
}

type ProductRow = {
  id: number
  title: string
  thumbnail_url: string | null
  images: unknown
  variant_price: unknown
  variant_currency_code: string | null
  total_inventory: unknown
  available_for_sale: boolean | null
}

async function loadProductForOrder(
  productId: string,
  packaging: 'single' | 'set' = 'single',
): Promise<ProductRow | null> {
  const idNum = Number(productId)
  if (!Number.isFinite(idNum)) return null
  const orderDirection = packaging === 'set' ? 'DESC' : 'ASC'
  const result = await runQuery<ProductRow>(
    `
      SELECT
        p.id,
        p.title,
        p.thumbnail_url,
        p.images,
        p.total_inventory,
        p.available_for_sale,
        v.price as variant_price,
        v.currency_code as variant_currency_code
      FROM products p
      LEFT JOIN LATERAL (
        SELECT price, currency_code
        FROM product_variants
        WHERE product_id = p.id
        ORDER BY price ${orderDirection} NULLS LAST
        LIMIT 1
      ) v ON true
      WHERE p.id = $1
      LIMIT 1
    `,
    [idNum],
  )
  return result.rows[0] || null
}

function featuredImage(row: ProductRow): string | null {
  const images: string[] = Array.isArray(row.images) ? row.images : []
  return row.thumbnail_url || images[0] || null
}

export type BuildLinesResult =
  | { ok: true; lines: OrderLine[]; currency: string }
  | { ok: false; status: number; error: string; detail?: string }

export async function buildOrderLinesFromItems(items: LineInput[]): Promise<BuildLinesResult> {
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, status: 400, error: 'items array is required' }
  }
  if (items.length > 30) {
    return { ok: false, status: 400, error: 'Too many line items' }
  }

  const lines: OrderLine[] = []
  let currency = ''
  const demandByProductId = new Map<number, number>()
  const productRowsById = new Map<number, ProductRow>()

  for (const raw of items) {
    const qty = Math.max(1, Math.min(99, Math.floor(Number(raw.quantity) || 0)))
    const packaging = raw.packaging === 'set' ? 'set' : 'single'
    const row = await loadProductForOrder(String(raw.productId), packaging)
    if (!row) {
      return { ok: false, status: 400, error: `Unknown product: ${raw.productId}` }
    }
    const { totalInventory, inStock } = stockFieldsFromRow(row)
    if (!inStock) {
      return { ok: false, status: 400, error: `${row.title} is out of stock` }
    }
    productRowsById.set(row.id, row)
    const nextDemand = (demandByProductId.get(row.id) || 0) + qty
    demandByProductId.set(row.id, nextDemand)
    if (totalInventory != null && nextDemand > totalInventory) {
      const left = totalInventory
      return {
        ok: false,
        status: 400,
        error: left === 0 ? `${row.title} is out of stock` : `Only ${left} in stock for ${row.title}`,
      }
    }
    const { cents, currency: cur } = moneyStringToCents(row.variant_price, row.variant_currency_code || 'USD')
    if (cents <= 0) {
      return { ok: false, status: 400, error: `Product has no price: ${raw.productId}` }
    }
    if (!currency) currency = cur
    else if (cur !== currency) {
      return { ok: false, status: 400, error: 'Mixed currencies in one order are not supported' }
    }
    const lineTotal = cents * qty
    lines.push({
      productId: row.id,
      title: row.title,
      unitCents: cents,
      currency: cur,
      qty,
      lineTotal,
      imageUrl: featuredImage(row),
      packaging,
    })
  }

  for (const [productId, requestedQty] of demandByProductId) {
    const row = productRowsById.get(productId)
    if (!row) continue
    const totalInventory = parseTotalInventory(row.total_inventory)
    if (!isProductInStock(totalInventory, row.available_for_sale)) {
      return { ok: false, status: 400, error: `${row.title} is out of stock` }
    }
    if (totalInventory != null && requestedQty > totalInventory) {
      return {
        ok: false,
        status: 400,
        error:
          totalInventory === 0
            ? `${row.title} is out of stock`
            : `Only ${totalInventory} in stock for ${row.title}`,
      }
    }
  }

  return { ok: true, lines, currency }
}

export async function getUserWonderCoinsBalance(userId: string): Promise<number> {
  const r = await runQuery<{ wonder_coins: number }>(
    `SELECT wonder_coins FROM users WHERE id::text = $1 LIMIT 1`,
    [userId],
  )
  const v = r.rows[0]?.wonder_coins
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
}

export type OrderQuoteResult = {
  subtotalCents: number
  discountCents: number
  wonderCoinsRedeemed: number
  wonderCoinsEarned: number
  shippingCents: number
  totalCents: number
  freeDelivery: boolean
  maxRedeemableCoins: number
  walletBalance: number
  currency: string
}

export type QuoteOrderCartResult =
  | { ok: true; quote: OrderQuoteResult; lines: OrderLine[] }
  | { ok: false; status: number; error: string; detail?: string }

export async function quoteOrderCart(params: {
  userId: string
  items: LineInput[]
  pudoLockerTier: string
  wonderCoinsToRedeem: number
}): Promise<QuoteOrderCartResult> {
  const built = await buildOrderLinesFromItems(params.items)
  if (!built.ok) {
    return { ok: false, status: built.status, error: built.error, detail: built.detail }
  }

  const { lines, currency } = built
  const tierRaw = String(params.pudoLockerTier || '').trim().toLowerCase()
  if (!isValidPudoLockerTier(tierRaw)) {
    return { ok: false, status: 400, error: 'pudoLockerTier is required (locker or door)' }
  }
  const pudoLockerTier = tierRaw as PudoLockerTier

  if (orderHasWholeSetLine(lines) && pudoLockerTier !== 'door') {
    return { ok: false, status: 400, error: 'Whole set orders require door delivery (R110).' }
  }

  const subtotalCents = lines.reduce((s, l) => s + l.lineTotal, 0)
  if (currency !== 'ZAR') {
    return {
      ok: false,
      status: 400,
      error: 'Domestic Pudo locker shipping applies to ZAR-priced items only',
      detail: `This cart is priced in ${currency}.`,
    }
  }

  const shippingCents = shippingCentsForOrder(subtotalCents, currency, pudoLockerTier)
  const walletBalance = await getUserWonderCoinsBalance(params.userId)
  const coinQuote = quoteOrderWonderCoins({
    subtotalCents,
    shippingCents,
    balance: walletBalance,
    wonderCoinsToRedeem: params.wonderCoinsToRedeem,
  })

  return {
    ok: true,
    lines,
    quote: {
      subtotalCents,
      discountCents: coinQuote.discountCents,
      wonderCoinsRedeemed: coinQuote.wonderCoinsRedeemed,
      wonderCoinsEarned: coinQuote.wonderCoinsEarned,
      shippingCents,
      totalCents: coinQuote.totalCents,
      freeDelivery: qualifiesForFreeDeliveryZar(subtotalCents, currency),
      maxRedeemableCoins: coinQuote.maxRedeemableCoins,
      walletBalance,
      currency,
    },
  }
}
