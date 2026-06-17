/** WonderCoins conversion rates — aligned with WONDERCOINS.md (website). */

export const WONDER_COINS_PER_RAND_SPENT = 1
export const WONDER_COINS_PER_RAND_VALUE = 10
export const YOCO_MIN_TOTAL_CENTS = 200

export function discountCentsFromPoints(points: number): number {
  const p = Math.max(0, Math.floor(points))
  if (p <= 0) return 0
  return Math.floor((p * 100) / WONDER_COINS_PER_RAND_VALUE)
}

export function pointsFromDiscountCents(discountCents: number): number {
  const c = Math.max(0, Math.floor(discountCents))
  if (c <= 0) return 0
  return Math.floor((c * WONDER_COINS_PER_RAND_VALUE) / 100)
}

export function coinsEarnedFromMerchandiseCents(subtotalAfterDiscountCents: number): number {
  const sub = Math.max(0, Math.floor(subtotalAfterDiscountCents))
  if (sub <= 0) return 0
  return Math.floor(sub / 100) * WONDER_COINS_PER_RAND_SPENT
}

export function maxRedeemablePoints(balance: number, subtotalCents: number): number {
  const bal = Math.max(0, Math.floor(balance))
  const sub = Math.max(0, Math.floor(subtotalCents))
  if (bal <= 0 || sub <= 0) return 0
  return Math.min(bal, pointsFromDiscountCents(sub))
}

export type OrderWonderCoinsQuote = {
  discountCents: number
  wonderCoinsRedeemed: number
  wonderCoinsEarned: number
  subtotalAfterDiscountCents: number
  totalCents: number
  maxRedeemableCoins: number
}

export function quoteOrderWonderCoins(params: {
  subtotalCents: number
  shippingCents: number
  balance: number
  wonderCoinsToRedeem: number
}): OrderWonderCoinsQuote {
  const subtotalCents = Math.max(0, Math.floor(params.subtotalCents))
  const shippingCents = Math.max(0, Math.floor(params.shippingCents))
  const balance = Math.max(0, Math.floor(params.balance))
  const maxCoins = maxRedeemablePoints(balance, subtotalCents)

  let requested = Math.max(0, Math.floor(params.wonderCoinsToRedeem))
  if (!Number.isFinite(requested)) requested = 0
  const wonderCoinsRedeemed = Math.min(requested, maxCoins)

  let discountCents = discountCentsFromPoints(wonderCoinsRedeemed)
  if (discountCents > subtotalCents) {
    discountCents = subtotalCents
  }

  const settledPoints = pointsFromDiscountCents(discountCents)
  const subtotalAfterDiscountCents = subtotalCents - discountCents
  let totalCents = subtotalAfterDiscountCents + shippingCents

  if (totalCents > 0 && totalCents < YOCO_MIN_TOTAL_CENTS) {
    const maxDiscountForMin = Math.max(0, subtotalCents + shippingCents - YOCO_MIN_TOTAL_CENTS)
    const cappedDiscount = Math.min(discountCents, maxDiscountForMin)
    const cappedPoints = pointsFromDiscountCents(cappedDiscount)
    const afterDiscount = subtotalCents - cappedDiscount
    return {
      discountCents: cappedDiscount,
      wonderCoinsRedeemed: cappedPoints,
      wonderCoinsEarned: coinsEarnedFromMerchandiseCents(afterDiscount),
      subtotalAfterDiscountCents: afterDiscount,
      totalCents: afterDiscount + shippingCents,
      maxRedeemableCoins: maxCoins,
    }
  }

  return {
    discountCents,
    wonderCoinsRedeemed: settledPoints,
    wonderCoinsEarned: coinsEarnedFromMerchandiseCents(subtotalAfterDiscountCents),
    subtotalAfterDiscountCents,
    totalCents,
    maxRedeemableCoins: maxCoins,
  }
}
