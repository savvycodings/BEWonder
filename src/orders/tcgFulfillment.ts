import { pool } from '../db/client'
import { getTcgConfig, tcgConfigReadyForShipment } from './tcgConfig'
import { tcgPostJson } from './tcgClient'
import {
  buildTcgRatesBody,
  buildTcgShipmentBody,
  pickServiceLevelCodeFromRatesJson,
  type OrderLineRow,
  type OrderShipmentRow,
} from './tcgShipmentFromOrder'

function extractShipmentFields(data: Record<string, unknown>) {
  const id = data?.id != null ? String(data.id) : ''
  const shortRef =
    data.short_tracking_reference != null ? String(data.short_tracking_reference) : null
  const customRef =
    data.custom_tracking_reference != null ? String(data.custom_tracking_reference) : null
  const status = data.status != null ? String(data.status) : null
  return { id, shortRef, customRef, status }
}

async function resolveServiceLevelCode(
  order: OrderShipmentRow,
  lines: OrderLineRow[],
  cfg: ReturnType<typeof getTcgConfig>
): Promise<string> {
  if (cfg.serviceLevelCode) return cfg.serviceLevelCode

  const ratesBody = buildTcgRatesBody(order, lines, cfg)
  const res = await tcgPostJson<unknown>('/rates', ratesBody)
  if (!res.ok) {
    const extra = res.bodyText && res.bodyText !== res.error ? `\n${String(res.bodyText).slice(0, 600)}` : ''
    throw new Error(`${res.error}${extra}`)
  }
  const code = pickServiceLevelCodeFromRatesJson(res.data)
  if (!code) {
    throw new Error(
      'ShipLogic /rates returned no service_level_code; set TCG_SERVICE_LEVEL_CODE in env.'
    )
  }
  return code
}

/**
 * Creates a ShipLogic shipment for a paid order once (idempotent). Uses a DB row lock during the
 * outbound HTTP calls to avoid duplicate shipments under concurrent webhooks.
 */
export async function createTcgShipmentForPaidOrderIfNeeded(orderId: string): Promise<void> {
  if (!tcgConfigReadyForShipment()) {
    return
  }
  const cfg = getTcgConfig()

  const client = await pool.connect()
  let order: OrderShipmentRow | undefined
  let lines: OrderLineRow[] = []

  try {
    await client.query('BEGIN')

    const ores = await client.query<OrderShipmentRow>(
      `
        SELECT
          id, reference_code, status, delivery_method,
          contact_phone, contact_email,
          shipping_snapshot_name, shipping_snapshot_line1, shipping_snapshot_line2,
          pudo_locker_name, pudo_locker_address,
          tcg_shipment_id
        FROM orders
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [orderId]
    )
    order = ores.rows[0]
    if (!order || order.status !== 'paid' || order.tcg_shipment_id) {
      await client.query('ROLLBACK')
      return
    }

    const lres = await client.query<OrderLineRow>(
      `
        SELECT title, quantity::int AS quantity
        FROM order_line_items
        WHERE order_id = $1::uuid
        ORDER BY created_at ASC
      `,
      [orderId]
    )
    lines = lres.rows

    const serviceLevel = await resolveServiceLevelCode(order, lines, cfg)
    const shipmentBody = buildTcgShipmentBody(order, lines, cfg, serviceLevel)

    const shipRes = await tcgPostJson<Record<string, unknown>>('/shipments', shipmentBody)
    if (!shipRes.ok) {
      const detail = [
        shipRes.error,
        shipRes.bodyText && shipRes.bodyText !== shipRes.error ? shipRes.bodyText.slice(0, 800) : '',
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000)
      await client.query(
        `
          UPDATE orders
          SET tcg_last_error = $2, updated_at = NOW()
          WHERE id = $1::uuid
        `,
        [orderId, detail]
      )
      await client.query('COMMIT')
      console.error('[tcg] POST /shipments failed', order.reference_code, shipRes.error)
      return
    }

    const refs = extractShipmentFields(shipRes.data)
    if (!refs.id) {
      const msg = 'ShipLogic response missing shipment id'
      await client.query(
        `UPDATE orders SET tcg_last_error = $2, updated_at = NOW() WHERE id = $1::uuid`,
        [orderId, msg]
      )
      await client.query('COMMIT')
      console.error('[tcg]', msg, order.reference_code)
      return
    }

    await client.query(
      `
        UPDATE orders
        SET
          tcg_shipment_id = $2,
          tcg_short_tracking_reference = $3,
          tcg_custom_tracking_reference = $4,
          tcg_shipment_status = COALESCE($5, tcg_shipment_status),
          tcg_last_sync_at = NOW(),
          tcg_last_error = NULL,
          updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [orderId, refs.id, refs.shortRef, refs.customRef, refs.status]
    )

    await client.query('COMMIT')
  } catch (e: any) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    const msg = String(e?.message || e || 'unknown error').slice(0, 2000)
    console.error('[tcg] fulfillment error', orderId, msg)
    try {
      await pool.query(
        `UPDATE orders SET tcg_last_error = $2, updated_at = NOW() WHERE id = $1::uuid`,
        [orderId, msg]
      )
    } catch {
      /* ignore */
    }
  } finally {
    client.release()
  }
}

/** Apply tracking webhook payload to `orders` when `shipment_id` matches. */
export async function applyTcgTrackingToOrder(shipmentId: string, status: string): Promise<number> {
  const res = await pool.query(
    `
      UPDATE orders
      SET
        tcg_shipment_status = $2,
        tcg_last_sync_at = NOW(),
        updated_at = NOW()
      WHERE tcg_shipment_id = $1
      RETURNING id
    `,
    [shipmentId, status.slice(0, 200)]
  )
  return res.rowCount || 0
}
