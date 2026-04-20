import crypto from 'crypto'

export type PeachWebhookEnvelope = {
  type?: string
  action?: string
  payload?: Record<string, unknown>
}

/**
 * Peach webhooks may send AES-256-GCM encrypted body (hex) + IV + auth tag in headers.
 * If PEACH_WEBHOOK_SECRET (64 hex chars) is set and IV/tag present, decrypt; else parse JSON.
 */
export function parsePeachWebhookBody(
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>
): PeachWebhookEnvelope | null {
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8').trim() : String(rawBody).trim()
  if (!bodyStr) return null

  const keyHex = process.env.PEACH_WEBHOOK_SECRET?.trim()
  const ivHeader = pickHeader(headers, 'x-initialization-vector')
  const tagHeader = pickHeader(headers, 'x-authentication-tag')

  if (keyHex && keyHex.length === 64 && ivHeader && tagHeader) {
    try {
      const key = Buffer.from(keyHex, 'hex')
      const iv = Buffer.from(ivHeader, 'hex')
      const tag = Buffer.from(tagHeader, 'hex')
      const encrypted = Buffer.from(bodyStr.replace(/^["']|["']$/g, ''), 'hex')
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
      const parsed = JSON.parse(decrypted.toString('utf8')) as PeachWebhookEnvelope
      return parsed
    } catch {
      /* fall through to plain JSON */
    }
  }

  try {
    const asJson = JSON.parse(bodyStr) as { encryptedBody?: string } | PeachWebhookEnvelope
    if (typeof (asJson as any).encryptedBody === 'string' && keyHex && keyHex.length === 64 && ivHeader && tagHeader) {
      const key = Buffer.from(keyHex, 'hex')
      const iv = Buffer.from(ivHeader, 'hex')
      const tag = Buffer.from(tagHeader, 'hex')
      const encrypted = Buffer.from((asJson as any).encryptedBody, 'hex')
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
      return JSON.parse(decrypted.toString('utf8')) as PeachWebhookEnvelope
    }
    return asJson as PeachWebhookEnvelope
  } catch {
    return null
  }
}

function pickHeader(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) {
      const v = h[k]
      return Array.isArray(v) ? v[0] : v
    }
  }
  return undefined
}
