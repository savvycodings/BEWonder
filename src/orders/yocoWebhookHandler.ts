import { Request, Response } from 'express'
import { pool } from '../db/client'
import { verifyYocoWebhookSignature } from './yocoWebhookVerify'
import { applyYocoPaymentToOrder, runYocoPaymentSideEffects } from './yocoApplyPayment'

type YocoWebhookEnvelope = {
  type?: string
  payload?: Record<string, unknown>
  id?: string
}

function readHeader(req: Request, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()]
  if (Array.isArray(v)) return v[0]
  return typeof v === 'string' ? v : undefined
}

function extractReferenceCode(payload: Record<string, unknown>): string | null {
  const meta = payload.metadata
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>
    const ref = m.referenceCode ?? m.orderReference ?? m.reference_code
    if (typeof ref === 'string' && ref.trim()) return ref.trim()
  }
  const clientRef = payload.clientReferenceId
  if (typeof clientRef === 'string' && clientRef.trim()) return clientRef.trim()
  return null
}

function extractCheckoutId(payload: Record<string, unknown>): string | null {
  const checkoutId = payload.checkoutId ?? payload.checkout_id
  if (typeof checkoutId === 'string' && checkoutId.trim()) return checkoutId.trim()
  return null
}

function extractPaymentId(payload: Record<string, unknown>): string | null {
  const id = payload.id ?? payload.paymentId ?? payload.payment_id
  if (typeof id === 'string' && id.trim()) return id.trim()
  return null
}

export async function handleYocoWebhook(req: Request, res: Response) {
  const raw =
    req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '')
  const webhookSecret = process.env.YOCO_WEBHOOK_SECRET?.trim()

  if (webhookSecret) {
    const verified = verifyYocoWebhookSignature({
      rawBody: raw,
      webhookId: readHeader(req, 'webhook-id'),
      webhookTimestamp: readHeader(req, 'webhook-timestamp'),
      webhookSignature: readHeader(req, 'webhook-signature'),
      secret: webhookSecret,
    })
    if (!verified.ok) {
      console.warn('[yoco webhook] signature rejected:', verified.reason)
      return res.status(403).json({ ok: false })
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.error('[yoco webhook] YOCO_WEBHOOK_SECRET not set in production')
    return res.status(503).json({ ok: false })
  } else {
    console.warn('[yoco webhook] YOCO_WEBHOOK_SECRET unset — skipping signature verification (dev only)')
  }

  let envelope: YocoWebhookEnvelope
  try {
    envelope = JSON.parse(raw) as YocoWebhookEnvelope
  } catch {
    return res.status(400).json({ ok: false })
  }

  const eventType = String(envelope.type || '').toLowerCase()
  const payload = (envelope.payload || envelope) as Record<string, unknown>
  const success = eventType === 'payment.succeeded'
  const failed = eventType === 'payment.failed'

  if (!success && !failed) {
    return res.status(200).json({ ok: true, ignored: true })
  }

  const merchantRef = extractReferenceCode(payload)
  const checkoutId = extractCheckoutId(payload)
  const paymentId = extractPaymentId(payload)
  const externalId =
    paymentId ||
    readHeader(req, 'webhook-id') ||
    (checkoutId ? `${checkoutId}:${eventType}` : `${merchantRef || 'unknown'}:${eventType}`)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    let orderRes
    if (merchantRef) {
      orderRes = await client.query<{
        id: string
        user_id: string
        payment_method: string
        status: string
        total_cents: number
        currency_code: string
      }>(
        `
          SELECT id, user_id, payment_method, status, total_cents, currency_code
          FROM orders
          WHERE reference_code = $1
          LIMIT 1
          FOR UPDATE
        `,
        [merchantRef]
      )
    } else if (checkoutId) {
      orderRes = await client.query(
        `
          SELECT id, user_id, payment_method, status, total_cents, currency_code
          FROM orders
          WHERE yoco_checkout_id = $1
          LIMIT 1
          FOR UPDATE
        `,
        [checkoutId]
      )
    } else {
      await client.query('ROLLBACK')
      return res.status(200).json({ ok: true, ignored: true })
    }

    const order = orderRes.rows[0]
    if (!order || order.payment_method !== 'yoco') {
      await client.query('ROLLBACK')
      return res.status(200).json({ ok: true, ignored: true })
    }

    let becamePaid = false
    try {
      const applied = await applyYocoPaymentToOrder(client, {
        order,
        success,
        checkoutId,
        paymentId,
        externalId,
        eventType: 'webhook',
        payload: { type: eventType, payload },
      })
      becamePaid = applied.becamePaid
    } catch (e: any) {
      if (e?.code === '23505') {
        await client.query('ROLLBACK')
        return res.status(200).json({ ok: true, duplicate: true })
      }
      console.error('[yoco webhook] apply payment failed', e)
      await client.query('ROLLBACK')
      return res.status(500).json({ ok: false })
    }

    await client.query('COMMIT')
    void runYocoPaymentSideEffects(order.id, becamePaid, success)

    return res.status(200).json({ ok: true })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    console.error('[yoco webhook] transaction failed', error)
    return res.status(500).json({ ok: false })
  } finally {
    client.release()
  }
}
