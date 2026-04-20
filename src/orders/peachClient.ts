import fetch from 'node-fetch'

export type CheckoutResult =
  | { ok: true; checkoutId: string; ndc?: string }
  | { ok: false; error: string; status?: number }

/**
 * Creates an OPP/Peach checkout session (Copy and Pay style).
 * Env: PEACH_API_BASE (default https://test.oppwa.com), PEACH_ENTITY_ID, PEACH_BEARER_TOKEN
 */
export async function createPeachCheckout(params: {
  amountDecimal: string
  currency: string
  merchantTransactionId: string
}): Promise<CheckoutResult> {
  const base = (process.env.PEACH_API_BASE || 'https://test.oppwa.com').replace(/\/$/, '')
  const entityId = process.env.PEACH_ENTITY_ID
  const bearer = process.env.PEACH_BEARER_TOKEN
  if (!entityId || !bearer) {
    return { ok: false, error: 'Peach is not configured (PEACH_ENTITY_ID / PEACH_BEARER_TOKEN)' }
  }

  const body = new URLSearchParams({
    entityId,
    amount: params.amountDecimal,
    currency: params.currency,
    paymentType: 'DB',
    merchantTransactionId: params.merchantTransactionId,
  })

  try {
    const res = await fetch(`${base}/v1/checkouts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${bearer}`,
      },
      body,
    })
    const json = (await res.json()) as any
    const id = json?.id as string | undefined
    if (!res.ok || !id) {
      const desc = json?.result?.description || json?.error || res.statusText
      return { ok: false, error: String(desc || 'Checkout create failed'), status: res.status }
    }
    return { ok: true, checkoutId: id, ndc: json?.ndc as string | undefined }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Peach checkout request failed' }
  }
}

/** Widget / hosted payment URL for WebView (test + live use same path pattern with checkoutId). */
export function peachPaymentWidgetUrl(checkoutId: string): string {
  const base = (process.env.PEACH_CHECKOUT_WIDGET_BASE || 'https://eu-test.oppwa.com').replace(/\/$/, '')
  return `${base}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(checkoutId)}`
}
