import crypto from 'crypto'
import { yocoLog } from './yocoLog'

const REPLAY_TOLERANCE_SEC = 180

function parseSignatureHeader(header: string): string[] {
  const out: string[] = []
  for (const part of header.trim().split(/\s+/)) {
    const sig = part.split(',').pop()
    if (sig) out.push(sig)
  }
  return out
}

/** Build candidate HMAC keys — Yoco portal may issue whsec_* (base64) or yoco_live_* (utf-8). */
function webhookSecretKeyCandidates(secret: string): Buffer[] {
  const candidates: Buffer[] = []
  const seen = new Set<string>()

  const add = (buf: Buffer) => {
    const key = buf.toString('base64')
    if (!buf.length || seen.has(key)) return
    seen.add(key)
    candidates.push(buf)
  }

  if (secret.startsWith('whsec_')) {
    const payload = secret.slice('whsec_'.length)
    try {
      add(Buffer.from(payload, 'base64'))
    } catch {
      /* ignore */
    }
  }

  if (secret.startsWith('yoco_live_') || secret.startsWith('yoco_test_')) {
    add(Buffer.from(secret, 'utf-8'))
    const afterPrefix = secret.replace(/^yoco_(live|test)_/, '')
    if (afterPrefix) {
      add(Buffer.from(afterPrefix, 'utf-8'))
      const compact = afterPrefix.replace(/_/g, '')
      if (/^[0-9a-f]+$/i.test(compact) && compact.length % 2 === 0) {
        try {
          add(Buffer.from(compact, 'hex'))
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Older docs: whsec_<base64> via split — wrong for yoco_live_* but kept for whsec_* keys
  if (secret.startsWith('whsec_')) {
    const legacyPayload = secret.split('_').slice(1).join('_')
    try {
      add(Buffer.from(legacyPayload, 'base64'))
    } catch {
      /* ignore */
    }
  }

  add(Buffer.from(secret, 'utf-8'))
  return candidates
}

function signaturesMatch(expectedB64: string, provided: string): boolean {
  try {
    const a = Buffer.from(expectedB64)
    const b = Buffer.from(provided)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
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
}): { ok: true; strategy: string } | { ok: false; reason: string } {
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

  const providedSigs = parseSignatureHeader(webhookSignature)
  if (!providedSigs.length) {
    return { ok: false, reason: 'invalid webhook-signature header' }
  }

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`
  const keyCandidates = webhookSecretKeyCandidates(secret)

  const strategies = [
    'whsec_base64',
    'yoco_utf8_full',
    'yoco_utf8_after_prefix',
    'yoco_hex_compact',
    'whsec_legacy_join',
    'utf8_raw',
  ]

  for (let i = 0; i < keyCandidates.length; i++) {
    const keyBytes = keyCandidates[i]
    const expected = crypto.createHmac('sha256', keyBytes).update(signedContent).digest('base64')
    for (const provided of providedSigs) {
      if (signaturesMatch(expected, provided)) {
        const strategy = strategies[i] || `candidate_${i}`
        yocoLog('webhook signature ok', { strategy, webhookId })
        return { ok: true, strategy }
      }
    }
  }

  yocoLog('webhook signature mismatch', {
    webhookId,
    keyCandidatesTried: keyCandidates.length,
    providedSignatures: providedSigs.length,
  })
  return { ok: false, reason: 'signature mismatch' }
}
