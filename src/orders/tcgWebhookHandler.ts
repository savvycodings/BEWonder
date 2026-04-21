import crypto from 'crypto'
import { Request, Response } from 'express'
import { pool } from '../db/client'
import { getTcgConfig } from './tcgConfig'
import { applyTcgTrackingToOrder } from './tcgFulfillment'

function timingSafeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function parseShipmentStatusPayload(body: unknown): { shipmentId: string; status: string; shortRef?: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const o = body as Record<string, unknown>
  const sid = o.shipment_id ?? o.shipmentId
  const st = o.status
  if (sid == null || typeof st !== 'string' || !st.trim()) return null
  const shortRaw = o.short_tracking_reference ?? o.shipment_short_tracking_reference
  const shortRef = typeof shortRaw === 'string' && shortRaw.trim() ? shortRaw.trim() : undefined
  return { shipmentId: String(sid), status: st.trim(), shortRef }
}

async function updateOrderTracking(
  shipmentId: string,
  shortRef: string | undefined,
  status: string
): Promise<void> {
  let n = await applyTcgTrackingToOrder(shipmentId, status)
  if (n > 0) return
  if (shortRef) {
    await pool.query(
      `
        UPDATE orders
        SET
          tcg_shipment_status = $2,
          tcg_last_sync_at = NOW(),
          updated_at = NOW()
        WHERE tcg_short_tracking_reference = $1
      `,
      [shortRef, status.slice(0, 200)]
    )
  }
}

/**
 * ShipLogic / The Courier Guy account webhooks (tracking events, etc.).
 * Configure URL + header `X-Tcg-Webhook-Secret` in portal Settings → Webhook subscriptions.
 */
export async function handleTcgWebhook(req: Request, res: Response) {
  const secret = getTcgConfig().webhookSecret
  if (!secret) {
    return res.status(503).json({ ok: false, error: 'TCG_WEBHOOK_SECRET is not set' })
  }

  const provided = String(req.headers['x-tcg-webhook-secret'] || '')
  if (!timingSafeEqualString(provided, secret)) {
    return res.status(401).json({ ok: false })
  }

  const parsed = parseShipmentStatusPayload(req.body)
  if (!parsed) {
    return res.status(200).json({ ok: true, ignored: true })
  }

  try {
    await updateOrderTracking(parsed.shipmentId, parsed.shortRef, parsed.status)
    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('[tcg webhook] update failed', e)
    return res.status(500).json({ ok: false })
  }
}
