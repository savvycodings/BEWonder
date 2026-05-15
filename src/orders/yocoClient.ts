import fetch from 'node-fetch'
import { randomUUID } from 'crypto'

const YOCO_CHECKOUT_API = 'https://payments.yoco.com/api/checkouts'

export type YocoCheckoutResult =
  | {
      ok: true
      checkoutId: string
      redirectUrl: string
      status?: string
      processingMode?: string
    }
  | { ok: false; error: string; status?: number }

export type YocoCheckoutDetails = {
  id: string
  status: string
  amount: number
  currency: string
  paymentId: string | null
  processingMode?: string
  redirectUrl?: string
}

function yocoSecretKey(): string | null {
  const key = process.env.YOCO_SECRET_KEY?.trim()
  return key || null
}

/** Skip localhost return URLs — they break on device and can confuse Yoco redirects. */
export function resolveYocoReturnBaseUrl(override?: string): string | null {
  const base = (override || process.env.YOCO_RETURN_BASE_URL || process.env.PUBLIC_API_BASE_URL || '')
    .trim()
    .replace(/\/$/, '')
  if (!base) return null
  if (/localhost|127\.0\.0\.1/i.test(base)) return null
  return base
}

export function yocoReturnBaseUrl(): string {
  return resolveYocoReturnBaseUrl() || 'http://localhost:3050'
}

/**
 * Creates a Yoco Checkout session (hosted payment page).
 * @see https://developer.yoco.com/docs/checkout-api
 */
export async function createYocoCheckout(params: {
  amountCents: number
  currency: string
  orderId: string
  referenceCode: string
  idempotencyKey?: string
  returnBaseUrl?: string
}): Promise<YocoCheckoutResult> {
  const secret = yocoSecretKey()
  if (!secret) {
    return { ok: false, error: 'Yoco is not configured (YOCO_SECRET_KEY)' }
  }

  const currency = params.currency.trim().toUpperCase()
  if (currency !== 'ZAR') {
    return { ok: false, error: 'Yoco only supports ZAR' }
  }
  if (params.amountCents < 200) {
    return { ok: false, error: 'Yoco minimum charge is R2.00 (200 cents)' }
  }

  const body: Record<string, unknown> = {
    amount: params.amountCents,
    currency,
    clientReferenceId: params.referenceCode,
    externalId: params.orderId,
    metadata: {
      orderId: params.orderId,
      referenceCode: params.referenceCode,
    },
  }

  const returnBase = resolveYocoReturnBaseUrl(params.returnBaseUrl)
  if (returnBase) {
    body.successUrl = `${returnBase}/payment/yoco/success`
    body.failureUrl = `${returnBase}/payment/yoco/failed`
    body.cancelUrl = `${returnBase}/payment/yoco/cancelled`
  }

  const idempotencyKey = params.idempotencyKey || `${params.orderId}:${randomUUID()}`

  try {
    const res = await fetch(YOCO_CHECKOUT_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as Record<string, unknown>
    const id = typeof json.id === 'string' ? json.id : undefined
    const redirectUrl = typeof json.redirectUrl === 'string' ? json.redirectUrl : undefined
    if (!res.ok || !id || !redirectUrl) {
      const msg =
        (json as { message?: string }).message ||
        (json as { error?: string }).error ||
        res.statusText
      return { ok: false, error: String(msg || 'Checkout create failed'), status: res.status }
    }
    return {
      ok: true,
      checkoutId: id,
      redirectUrl,
      status: typeof json.status === 'string' ? json.status : undefined,
      processingMode:
        typeof json.processingMode === 'string' ? json.processingMode : undefined,
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Yoco checkout request failed'
    return { ok: false, error: message }
  }
}

export async function getYocoCheckout(checkoutId: string): Promise<
  | { ok: true; checkout: YocoCheckoutDetails }
  | { ok: false; error: string; status?: number }
> {
  const secret = yocoSecretKey()
  if (!secret) {
    return { ok: false, error: 'Yoco is not configured (YOCO_SECRET_KEY)' }
  }

  try {
    const res = await fetch(`${YOCO_CHECKOUT_API}/${encodeURIComponent(checkoutId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    })
    const json = (await res.json()) as Record<string, unknown>
    if (!res.ok) {
      const msg = (json as { message?: string }).message || res.statusText
      return { ok: false, error: String(msg || 'Could not load checkout'), status: res.status }
    }
    const id = typeof json.id === 'string' ? json.id : checkoutId
    const status = typeof json.status === 'string' ? json.status : 'unknown'
    const paymentId =
      typeof json.paymentId === 'string'
        ? json.paymentId
        : json.paymentId === null
          ? null
          : null
    return {
      ok: true,
      checkout: {
        id,
        status,
        amount: Number(json.amount) || 0,
        currency: String(json.currency || 'ZAR'),
        paymentId,
        processingMode:
          typeof json.processingMode === 'string' ? json.processingMode : undefined,
        redirectUrl: typeof json.redirectUrl === 'string' ? json.redirectUrl : undefined,
      },
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Yoco checkout lookup failed'
    return { ok: false, error: message }
  }
}
