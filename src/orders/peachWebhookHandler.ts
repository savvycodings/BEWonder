import { Request, Response } from 'express'
import { runQuery } from '../db/client'
import { parsePeachWebhookBody } from './peachWebhookDecrypt'

function resultCodeSuccess(code: unknown): boolean {
  const c = String(code || '')
  return c.startsWith('000.000.') || c === '000.000.000'
}

function extractMerchantRef(payload: Record<string, unknown>): string | null {
  const mt = payload.merchantTransactionId ?? (payload as any).merchantTransactionId
  if (typeof mt === 'string' && mt.trim()) return mt.trim()
  const custom = (payload as any).customParameters as Record<string, string> | undefined
  if (custom && typeof custom.WP_ORDER_REF === 'string') return custom.WP_ORDER_REF.trim()
  return null
}

export async function handlePeachWebhook(req: Request, res: Response) {
  const raw = req.body instanceof Buffer ? req.body : Buffer.from(String(req.body || ''), 'utf8')
  const envelope = parsePeachWebhookBody(raw, req.headers as any)
  if (!envelope) {
    return res.status(400).json({ ok: false })
  }

  const type = String(envelope.type || '')
  const payload = (envelope.payload || {}) as Record<string, unknown>
  const paymentId = typeof payload.id === 'string' ? payload.id : null
  const merchantRef = extractMerchantRef(payload)
  const result = (payload.result || {}) as { code?: string; description?: string }
  const success = resultCodeSuccess(result.code)

  if (type !== 'PAYMENT' || !merchantRef) {
    return res.status(200).json({ ok: true, ignored: true })
  }

  const orderRes = await runQuery<{ id: string; payment_method: string; status: string }>(
    `SELECT id, payment_method, status FROM orders WHERE reference_code = $1 LIMIT 1`,
    [merchantRef]
  )
  const order = orderRes.rows[0]
  if (!order || order.payment_method !== 'peach') {
    return res.status(200).json({ ok: true, ignored: true })
  }

  const statusAfter = success ? 'paid' : order.status === 'paid' ? 'paid' : 'failed'
  const shortId = typeof (payload as any).shortId === 'string' ? (payload as any).shortId : ''
  const externalId =
    paymentId || (shortId ? `${merchantRef}:${shortId}` : `${merchantRef}:${String(result.code || '')}`)

  try {
    await runQuery(
      `
        INSERT INTO order_payment_events (id, order_id, provider, event_type, status_after, external_event_id, payload_json)
        VALUES (gen_random_uuid(), $1, 'peach', 'webhook', $2, $3, $4::jsonb)
      `,
      [order.id, statusAfter, externalId, JSON.stringify({ type, payload })]
    )
  } catch (e: any) {
    if (e?.code === '23505') {
      return res.status(200).json({ ok: true, duplicate: true })
    }
    console.error('[peach webhook] insert event failed', e)
    return res.status(500).json({ ok: false })
  }

  await runQuery(
    `
      UPDATE orders
      SET
        status = CASE WHEN $2::text = 'paid' THEN 'paid' WHEN $2::text = 'failed' AND status = 'pending_payment' THEN 'failed' ELSE status END,
        peach_checkout_id = COALESCE(peach_checkout_id, $3),
        updated_at = NOW()
      WHERE id = $1
    `,
    [order.id, statusAfter, paymentId]
  )

  return res.status(200).json({ ok: true })
}
