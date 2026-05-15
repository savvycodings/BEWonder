import crypto from 'crypto'

const REPLAY_TOLERANCE_SEC = 180

function parseSignatureHeader(header: string): string | null {
  const first = header.trim().split(/\s+/)[0]
  if (!first) return null
  const parts = first.split(',')
  return parts.length >= 2 ? parts[1] : null
}

/**
 * Verifies Yoco Checkout webhook signatures.
 * @see https://developer.yoco.com/guides/online-payments/webhooks/verifying-the-events
 */
export function verifyYocoWebhookSignature(params: {
  rawBody: string
  webhookId: string | undefined
  webhookTimestamp: string | undefined
  webhookSignature: string | undefined
  secret: string
}): { ok: true } | { ok: false; reason: string } {
  const { rawBody, webhookId, webhookTimestamp, webhookSignature, secret } = params
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, reason: 'missing webhook headers' }
  }

  const ts = Number(webhookTimestamp)
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'invalid webhook-timestamp' }
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - ts) > REPLAY_TOLERANCE_SEC) {
    return { ok: false, reason: 'webhook timestamp outside tolerance' }
  }

  const providedSig = parseSignatureHeader(webhookSignature)
  if (!providedSig) {
    return { ok: false, reason: 'invalid webhook-signature header' }
  }

  let secretBytes: Buffer
  try {
    const rawSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
    secretBytes = Buffer.from(rawSecret, 'base64')
  } catch {
    return { ok: false, reason: 'invalid webhook secret encoding' }
  }

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64')

  try {
    const a = Buffer.from(expected)
    const b = Buffer.from(providedSig)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'signature mismatch' }
    }
  } catch {
    return { ok: false, reason: 'signature compare failed' }
  }

  return { ok: true }
}
