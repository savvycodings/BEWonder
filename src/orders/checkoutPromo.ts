import { runQuery } from '../db/client'

export const FIRST_ORDER_PROMO = {
  code: 'WONDER15',
  percent: 15,
} as const

export function normalizeCheckoutPromoCode(raw: string | null | undefined): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}

export function promoDiscountCents(subtotalCents: number, percent: number): number {
  const sub = Math.max(0, Math.floor(subtotalCents))
  const pct = Math.max(0, Math.floor(percent))
  if (sub <= 0 || pct <= 0) return 0
  return Math.floor((sub * pct) / 100)
}

export async function userHasPaidOrder(userId: string): Promise<boolean> {
  const id = String(userId || '').trim()
  if (!id) return false
  const r = await runQuery<{ one: number }>(
    `
      SELECT 1 AS one
      FROM orders
      WHERE user_id = $1
        AND status = 'paid'
      LIMIT 1
    `,
    [id],
  )
  return Boolean(r.rows[0])
}

export async function userHasOpenWonder15Order(userId: string): Promise<boolean> {
  const id = String(userId || '').trim()
  if (!id) return false
  const r = await runQuery<{ one: number }>(
    `
      SELECT 1 AS one
      FROM orders
      WHERE user_id = $1
        AND UPPER(TRIM(COALESCE(promo_code, ''))) = $2
        AND status NOT IN ('cancelled', 'failed')
      LIMIT 1
    `,
    [id, FIRST_ORDER_PROMO.code],
  )
  return Boolean(r.rows[0])
}

export type ResolveCheckoutPromoResult = {
  promoCode: string | null
  promoDiscountCents: number
  promoError: string | null
}

/**
 * Resolve WONDER15 (or clear) for a quote/create. Does not throw for ineligible codes —
 * returns promoError so quote can still succeed; create should 400 when requested but not applied.
 */
export async function resolveCheckoutPromo(params: {
  userId: string | null
  rawPromoCode: string | null | undefined
  subtotalCents: number
}): Promise<ResolveCheckoutPromoResult> {
  const normalized = normalizeCheckoutPromoCode(params.rawPromoCode)
  if (!normalized) {
    return { promoCode: null, promoDiscountCents: 0, promoError: null }
  }

  if (normalized !== FIRST_ORDER_PROMO.code) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'Invalid promo code.',
    }
  }

  if (!params.userId) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'Sign in to use this promo code.',
    }
  }

  if (await userHasPaidOrder(params.userId)) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'WONDER15 is only valid on your first order.',
    }
  }

  if (await userHasOpenWonder15Order(params.userId)) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'WONDER15 is already applied on another open order.',
    }
  }

  const discount = promoDiscountCents(params.subtotalCents, FIRST_ORDER_PROMO.percent)
  if (discount <= 0) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'Cart subtotal is too low to apply this promo.',
    }
  }

  return {
    promoCode: FIRST_ORDER_PROMO.code,
    promoDiscountCents: discount,
    promoError: null,
  }
}
