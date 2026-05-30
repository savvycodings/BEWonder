import 'dotenv/config'
import { pool } from '../dist/db/client.js'

const r = await pool.query(`
  SELECT status, delivery_method, COUNT(*)::int AS n
  FROM orders GROUP BY 1, 2 ORDER BY n DESC
`)
const paid = await pool.query(`
  SELECT reference_code, status, delivery_method, tcg_shipment_id, tcg_last_error, created_at
  FROM orders WHERE status = 'paid'
  ORDER BY created_at DESC LIMIT 15
`)
const pudoPaid = await pool.query(`
  SELECT reference_code, tcg_shipment_id, tcg_short_tracking_reference, tcg_last_error,
         tcg_locker_tier, tcg_parcel_length_cm, pudo_locker_name
  FROM orders WHERE delivery_method = 'pudo' AND status = 'paid'
  ORDER BY created_at DESC LIMIT 10
`)
console.log(JSON.stringify({ byStatus: r.rows, paid: paid.rows, pudoPaid: pudoPaid.rows }, null, 2))
await pool.end()
