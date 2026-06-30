import 'dotenv/config'
import pg from 'pg'
import { sendOrderPaidAdminNotification } from '../dist/notifications/sendOrderPaidAdminNotification.js'

const orderIdArg = process.argv[2]

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  let orderId = orderIdArg?.trim()

  if (!orderId) {
    const recent = await pool.query(`
      SELECT id, reference_code, updated_at
      FROM orders
      WHERE status = 'paid'
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    const row = recent.rows[0]
    if (!row) {
      throw new Error('No paid orders in database. Pass an order UUID: node scripts/send-test-order-paid-email.mjs <orderId>')
    }
    orderId = row.id
    console.log(`Using latest paid order: ${row.reference_code} (${orderId})`)
  }

  await pool.query(
    `UPDATE orders SET admin_purchase_notify_sent_at = NULL WHERE id = $1::uuid`,
    [orderId],
  )
  console.log('Cleared admin_purchase_notify_sent_at for test resend.')

  const notifyTo = process.env.ORDER_ADMIN_NOTIFY_EMAIL || 'info@wonderporthobbies.com'
  console.log(`Sending admin order-paid email (to ${notifyTo})...`)

  await sendOrderPaidAdminNotification(orderId)

  const check = await pool.query(
    `SELECT admin_purchase_notify_sent_at FROM orders WHERE id = $1::uuid`,
    [orderId],
  )
  if (check.rows[0]?.admin_purchase_notify_sent_at) {
    console.log('Done — admin_purchase_notify_sent_at is set (email send attempted).')
  } else {
    console.error('Email may not have sent — check server logs and Resend config.')
    process.exitCode = 1
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
