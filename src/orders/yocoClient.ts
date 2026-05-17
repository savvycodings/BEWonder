import fetch from 'node-fetch'
import { randomUUID } from 'crypto'
import { yocoKeyFingerprint, yocoKeyMode, yocoLog, yocoLogError } from './yocoLog'

const YOCO_CHECKOUT_API = 'https://payments.yoco.com/api/checkouts'

export type YocoCheckoutResult =
  | {
      ok: true
      checkoutId: string
      redirectUrl: string
      status?: string
      processingMode?: string
    }
  | { ok: false; error: string; status?: number; yocoBody?: Record<string, unknown> }

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

function parseYocoErrorBody(json: Record<string, unknown>, statusText: string): string {
  const description = json.description
  if (typeof description === 'string' && description.trim()) return description.trim()
  const message = json.message
  if (typeof message === 'string' && message.trim()) return message.trim()
  const error = json.error
  if (typeof error === 'string' && error.trim()) return error.trim()
  return statusText || 'Checkout create failed'
}

/** Skip localhost return URLs. Live keys require HTTPS return URLs if any are sent. */
export function resolveYocoReturnBaseUrl(override?: string): string | null {
  const base = (override || process.env.YOCO_RETURN_BASE_URL || process.env.PUBLIC_API_BASE_URL || '')
    .trim()
    .replace(/\/$/, '')
  if (!base) return null
  if (/localhost|127\.0\.0\.1/i.test(base)) return null
  return base
}

export function canAttachReturnUrls(returnBase: string | null, keyMode: 'live' | 'test' | 'unknown'): boolean {
  if (!returnBase) return false
  if (keyMode === 'live' && !returnBase.startsWith('https://')) {
    return false
  }
  return true
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
    yocoLogError('createCheckout skipped — YOCO_SECRET_KEY missing')
    return { ok: false, error: 'Yoco is not configured (YOCO_SECRET_KEY)' }
  }

  const keyMode = yocoKeyMode(secret)
  yocoLog('createCheckout start', {
    keyMode,
    key: yocoKeyFingerprint(secret),
    orderId: params.orderId,
    referenceCode: params.referenceCode,
    amountCents: params.amountCents,
    currency: params.currency,
    returnBaseUrl: params.returnBaseUrl || null,
  })

  const currency = params.currency.trim().toUpperCase()
  if (currency !== 'ZAR') {
    yocoLogError('createCheckout rejected — currency', { currency })
    return { ok: false, error: 'Yoco only supports ZAR' }
  }
  if (params.amountCents < 200) {
    yocoLogError('createCheckout rejected — amount below minimum', { amountCents: params.amountCents })
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
  if (canAttachReturnUrls(returnBase, keyMode)) {
    body.successUrl = `${returnBase}/payment/yoco/success`
    body.failureUrl = `${returnBase}/payment/yoco/failed`
    body.cancelUrl = `${returnBase}/payment/yoco/cancelled`
    yocoLog('createCheckout return URLs attached', {
      successUrl: body.successUrl,
    })
  } else if (returnBase && keyMode === 'live') {
    yocoLog('createCheckout return URLs omitted — live keys require HTTPS', {
      returnBase,
      hint: 'Use sk_test_ for local HTTP dev, or set YOCO_RETURN_BASE_URL to an https URL (e.g. ngrok)',
    })
  } else if (!returnBase) {
    yocoLog('createCheckout return URLs omitted — no public return base', {
      returnBaseUrlFromApp: params.returnBaseUrl || null,
    })
  }

  const idempotencyKey = params.idempotencyKey || `${params.orderId}:${randomUUID()}`

  try {
    yocoLog('createCheckout POST', {
      url: YOCO_CHECKOUT_API,
      idempotencyKey,
      body,
    })

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
      const msg = parseYocoErrorBody(json, res.statusText)
      yocoLogError('createCheckout failed', {
        httpStatus: res.status,
        message: msg,
        yocoResponse: json,
      })
      return {
        ok: false,
        error: msg,
        status: res.status,
        yocoBody: json,
      }
    }

    const processingMode =
      typeof json.processingMode === 'string' ? json.processingMode : undefined
    yocoLog('createCheckout success', {
      httpStatus: res.status,
      checkoutId: id,
      processingMode,
      redirectUrl,
    })

    if (keyMode === 'live' || processingMode === 'live') {
      yocoLog('LIVE mode — use a real bank card (test card 4111… only works with sk_test_ keys)')
    }

    return {
      ok: true,
      checkoutId: id,
      redirectUrl,
      status: typeof json.status === 'string' ? json.status : undefined,
      processingMode,
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Yoco checkout request failed'
    yocoLogError('createCheckout exception', { message })
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

  yocoLog('getCheckout', { checkoutId })

  try {
    const res = await fetch(`${YOCO_CHECKOUT_API}/${encodeURIComponent(checkoutId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    })
    const json = (await res.json()) as Record<string, unknown>
    if (!res.ok) {
      const msg = parseYocoErrorBody(json, res.statusText)
      yocoLogError('getCheckout failed', { httpStatus: res.status, message: msg, yocoResponse: json })
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
    yocoLog('getCheckout success', {
      checkoutId: id,
      status,
      paymentId,
      processingMode: json.processingMode,
    })
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
    yocoLogError('getCheckout exception', { message })
    return { ok: false, error: message }
  }
}
