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

export function wonder15MaxUses(): number {
  const n = Number.parseInt(String(process.env.PROMO_WONDER15_MAX_USES || '100'), 10)
  if (!Number.isFinite(n) || n < 0) return 100
  return n
}

/** Default % only if an entry is written as CODE without `:percent`. */
const DEFAULT_INFLUENCER_PERCENT = 10

/**
 * Parse one entry: `CODE:PERCENT` (e.g. AMANITA10:10).
 * Bare `CODE` falls back to 10%.
 */
export function parseInfluencerEntry(
  raw: string | null | undefined,
): { code: string; percent: number } | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null

  const colon = trimmed.indexOf(':')
  let codePart = trimmed
  let percent = DEFAULT_INFLUENCER_PERCENT
  if (colon >= 0) {
    codePart = trimmed.slice(0, colon)
    const pctRaw = trimmed.slice(colon + 1).trim()
    const n = Number.parseInt(pctRaw, 10)
    if (Number.isFinite(n) && n > 0) percent = n
  }

  const code = normalizeCheckoutPromoCode(codePart)
  if (!code) return null
  return { code, percent }
}

/**
 * All influencer codes → percent from PROMO_INFLUENCER_CODES
 * (comma-separated `CODE:PERCENT` entries).
 */
export function getInfluencerCodeMap(): Map<string, number> {
  const map = new Map<string, number>()
  const list = String(process.env.PROMO_INFLUENCER_CODES || '')
  for (const part of list.split(',')) {
    const entry = parseInfluencerEntry(part)
    if (entry) map.set(entry.code, entry.percent)
  }
  return map
}

export function getInfluencerCodes(): Set<string> {
  return new Set(getInfluencerCodeMap().keys())
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

export async function getWonder15GlobalUseCount(): Promise<number> {
  const r = await runQuery<{ cnt: string | number }>(
    `
      SELECT COUNT(*)::int AS cnt
      FROM orders
      WHERE UPPER(TRIM(COALESCE(promo_code, ''))) = $1
        AND status = 'paid'
    `,
    [FIRST_ORDER_PROMO.code],
  )
  return Math.max(0, Math.floor(Number(r.rows[0]?.cnt) || 0))
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

export async function userHasUsedAnyInfluencerCode(
  userId: string,
  influencerCodes: Set<string>,
): Promise<boolean> {
  const id = String(userId || '').trim()
  if (!id || influencerCodes.size === 0) return false
  const codes = Array.from(influencerCodes)
  const r = await runQuery<{ one: number }>(
    `
      SELECT 1 AS one
      FROM orders
      WHERE user_id = $1
        AND status = 'paid'
        AND UPPER(TRIM(COALESCE(promo_code, ''))) = ANY($2::text[])
      LIMIT 1
    `,
    [id, codes],
  )
  return Boolean(r.rows[0])
}

export async function userHasOpenInfluencerOrder(
  userId: string,
  influencerCodes: Set<string>,
): Promise<boolean> {
  const id = String(userId || '').trim()
  if (!id || influencerCodes.size === 0) return false
  const codes = Array.from(influencerCodes)
  const r = await runQuery<{ one: number }>(
    `
      SELECT 1 AS one
      FROM orders
      WHERE user_id = $1
        AND UPPER(TRIM(COALESCE(promo_code, ''))) = ANY($2::text[])
        AND status NOT IN ('cancelled', 'failed')
      LIMIT 1
    `,
    [id, codes],
  )
  return Boolean(r.rows[0])
}

export type ResolveCheckoutPromoResult = {
  promoCode: string | null
  promoDiscountCents: number
  promoError: string | null
}

/**
 * Resolve a single checkout promo (WONDER15 or influencer). Does not throw for ineligible codes —
 * returns promoError so quote can still succeed; create should 400 when requested but not applied.
 * Only one promo code can apply per order (no stacking).
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

  const influencerMap = getInfluencerCodeMap()
  const influencerCodes = new Set(influencerMap.keys())

  if (normalized === FIRST_ORDER_PROMO.code) {
    return resolveWonder15(params.userId, params.subtotalCents)
  }

  const percent = influencerMap.get(normalized)
  if (percent != null) {
    return resolveInfluencerCode({
      userId: params.userId,
      code: normalized,
      percent,
      subtotalCents: params.subtotalCents,
      influencerCodes,
    })
  }

  return {
    promoCode: null,
    promoDiscountCents: 0,
    promoError: 'Invalid promo code.',
  }
}

async function resolveWonder15(
  userId: string | null,
  subtotalCents: number,
): Promise<ResolveCheckoutPromoResult> {
  if (!userId) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'Sign in to use this promo code.',
    }
  }

  if (await userHasPaidOrder(userId)) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'WONDER15 is only valid on your first order.',
    }
  }

  const maxUses = wonder15MaxUses()
  const used = await getWonder15GlobalUseCount()
  if (used >= maxUses) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'WONDER15 has reached its usage limit.',
    }
  }

  if (await userHasOpenWonder15Order(userId)) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'WONDER15 is already applied on another open order.',
    }
  }

  const discount = promoDiscountCents(subtotalCents, FIRST_ORDER_PROMO.percent)
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

async function resolveInfluencerCode(params: {
  userId: string | null
  code: string
  percent: number
  subtotalCents: number
  influencerCodes: Set<string>
}): Promise<ResolveCheckoutPromoResult> {
  if (!params.userId) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'Sign in to use this promo code.',
    }
  }

  if (await userHasUsedAnyInfluencerCode(params.userId, params.influencerCodes)) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'You have already used an influencer code on a previous order.',
    }
  }

  if (await userHasOpenInfluencerOrder(params.userId, params.influencerCodes)) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'An influencer code is already applied on another open order.',
    }
  }

  const discount = promoDiscountCents(params.subtotalCents, params.percent)
  if (discount <= 0) {
    return {
      promoCode: null,
      promoDiscountCents: 0,
      promoError: 'Cart subtotal is too low to apply this promo.',
    }
  }

  return {
    promoCode: params.code,
    promoDiscountCents: discount,
    promoError: null,
  }
}
