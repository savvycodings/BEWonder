/**
 * Simulate paid Pudo order → TCG fulfillment hook (reverts DB after test).
 */
import 'dotenv/config'
import { pool } from '../dist/db/client.js'
import { createTcgShipmentForPaidOrderIfNeeded } from '../dist/orders/tcgFulfillment.js'

const pick = await pool.query(`
  SELECT o.id, o.reference_code, o.status,
         json_agg(json_build_object(
           'title', oli.title, 'qty', oli.quantity, 'packaging', oli.packaging
         )) AS lines
  FROM orders o
  JOIN order_line_items oli ON oli.order_id = o.id
  WHERE o.delivery_method = 'pudo' AND o.status = 'pending_payment'
  GROUP BY o.id
  ORDER BY o.created_at DESC
  LIMIT 1
`)

if (!pick.rows.length) {
  console.log('No pending Pudo order to simulate')
  await pool.end()
  process.exit(0)
}

const order = pick.rows[0]
console.log('Simulating payment + TCG booking for', order.reference_code, order.lines)

const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query(`UPDATE orders SET status = 'paid', updated_at = NOW() WHERE id = $1::uuid`, [order.id])
  await client.query('COMMIT')
} catch (e) {
  await client.query('ROLLBACK')
  throw e
} finally {
  client.release()
}

await createTcgShipmentForPaidOrderIfNeeded(order.id)

const after = await pool.query(`
  SELECT status, tcg_shipment_id, tcg_short_tracking_reference, tcg_last_error,
         tcg_locker_tier, tcg_parcel_length_cm, tcg_parcel_width_cm,
         tcg_parcel_height_cm, tcg_parcel_weight_kg
  FROM orders WHERE id = $1::uuid
`, [order.id])

console.log('After fulfillment attempt:', JSON.stringify(after.rows[0], null, 2))

// Revert so we don't leave test state
await pool.query(`
  UPDATE orders SET
    status = 'pending_payment',
    tcg_shipment_id = NULL,
    tcg_short_tracking_reference = NULL,
    tcg_custom_tracking_reference = NULL,
    tcg_shipment_status = NULL,
    tcg_locker_tier = NULL,
    tcg_parcel_length_cm = NULL,
    tcg_parcel_width_cm = NULL,
    tcg_parcel_height_cm = NULL,
    tcg_parcel_weight_kg = NULL,
    tcg_last_error = NULL,
    updated_at = NOW()
  WHERE id = $1::uuid
`, [order.id])

console.log('Reverted order to pending_payment')
await pool.end()
