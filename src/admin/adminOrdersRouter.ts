import express from 'express'
import { runQuery } from '../db/client'
import { requireAdmin, signAdminJwt, verifyAdminPassword } from './adminAuth'

const router = express.Router()

router.post('/orders/login', (req, res) => {
  const password = String(req.body?.password || '')
  const hasPassword = Boolean(process.env.ADMIN_ORDERS_PASSWORD?.trim())
  const jwtSecret = process.env.ADMIN_JWT_SECRET?.trim() || ''
  const hasJwt = jwtSecret.length >= 16

  if (!hasPassword || !hasJwt) {
    return res.status(503).json({
      error: 'Admin orders is not configured on the server',
      detail:
        'Add to the API .env file: ADMIN_ORDERS_PASSWORD (any strong secret) and ADMIN_JWT_SECRET (at least 16 characters), then restart the server.',
      missing: { password: !hasPassword, jwtSecret: !hasJwt },
    })
  }
  if (!verifyAdminPassword(password)) {
    return res.status(401).json({ error: 'Invalid password' })
  }
  const token = signAdminJwt()
  if (!token) {
    return res.status(503).json({
      error: 'Could not issue admin token',
      detail: 'Check ADMIN_JWT_SECRET is set and restart the server.',
    })
  }
  return res.status(200).json({ adminToken: token, expiresInSeconds: 8 * 60 * 60 })
})

router.get('/orders', requireAdmin, async (req, res) => {
  const pm = String(req.query.paymentMethod || 'all').toLowerCase()
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const offset = Math.max(0, Number(req.query.offset) || 0)

  const params: unknown[] = [limit, offset]
  let where = ''
  if (pm === 'peach' || pm === 'eft') {
    where = 'WHERE o.payment_method = $3'
    params.push(pm)
  }

  const result = await runQuery<{
    id: string
    reference_code: string
    status: string
    payment_method: string
    currency_code: string
    total_cents: number
    created_at: string
    user_id: string
    email: string | null
    name: string | null
  }>(
    `
      SELECT
        o.id,
        o.reference_code,
        o.status,
        o.payment_method,
        o.currency_code,
        o.total_cents,
        o.created_at,
        o.user_id,
        u.email,
        u.name
      FROM orders o
      JOIN users u ON u.id = o.user_id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT $1 OFFSET $2
    `,
    params
  )

  return res.status(200).json({
    orders: result.rows.map((r) => ({
      id: r.id,
      referenceCode: r.reference_code,
      status: r.status,
      paymentMethod: r.payment_method,
      currencyCode: r.currency_code,
      totalCents: r.total_cents,
      createdAt: r.created_at,
      userId: r.user_id,
      userEmail: r.email,
      userName: r.name,
    })),
  })
})

router.get('/users/:userId/orders', requireAdmin, async (req, res) => {
  const userId = String(req.params.userId || '').trim()
  if (!userId) return res.status(400).json({ error: 'userId required' })

  const userRes = await runQuery<{
    id: string
    email: string | null
    name: string | null
    image: string | null
    shipping_address1: string | null
    shipping_address2: string | null
    phone: string | null
    pudo_locker_name: string | null
    pudo_locker_address: string | null
    eft_bank_account_name: string | null
    eft_bank_name: string | null
    eft_bank_account_number: string | null
    eft_bank_branch: string | null
    created_at: string
  }>(
    `
      SELECT
        id,
        email,
        name,
        image,
        shipping_address1,
        shipping_address2,
        phone,
        pudo_locker_name,
        pudo_locker_address,
        eft_bank_account_name,
        eft_bank_name,
        eft_bank_account_number,
        eft_bank_branch,
        created_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  )
  const user = userRes.rows[0]
  if (!user) return res.status(404).json({ error: 'User not found' })

  const orders = await runQuery<{
    id: string
    reference_code: string
    status: string
    payment_method: string
    currency_code: string
    total_cents: number
    created_at: string
  }>(
    `
      SELECT id, reference_code, status, payment_method, currency_code, total_cents, created_at
      FROM orders
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 200
    `,
    [userId]
  )

  return res.status(200).json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      phone: user.phone,
      shippingAddress1: user.shipping_address1,
      shippingAddress2: user.shipping_address2,
      pudoLockerName: user.pudo_locker_name,
      pudoLockerAddress: user.pudo_locker_address,
      eftBankAccountName: user.eft_bank_account_name,
      eftBankName: user.eft_bank_name,
      eftBankAccountNumber: user.eft_bank_account_number,
      eftBankBranch: user.eft_bank_branch,
      createdAt: user.created_at,
    },
    orders: orders.rows.map((o) => ({
      id: o.id,
      referenceCode: o.reference_code,
      status: o.status,
      paymentMethod: o.payment_method,
      currencyCode: o.currency_code,
      totalCents: o.total_cents,
      createdAt: o.created_at,
    })),
  })
})

router.get('/orders/:orderId', requireAdmin, async (req, res) => {
  const orderId = String(req.params.orderId || '').trim()
  if (!orderId) return res.status(400).json({ error: 'orderId required' })

  const orderRes = await runQuery<{
    id: string
    user_id: string
    reference_code: string
    status: string
    payment_method: string
    currency_code: string
    subtotal_cents: number
    shipping_cents: number
    total_cents: number
    shipping_snapshot_name: string | null
    shipping_snapshot_line1: string | null
    shipping_snapshot_line2: string | null
    delivery_method: string | null
    contact_phone: string | null
    contact_email: string | null
    pudo_locker_name: string | null
    pudo_locker_address: string | null
    customer_eft_account_name: string | null
    customer_eft_bank_name: string | null
    customer_eft_account_number: string | null
    peach_checkout_id: string | null
    peach_resource_path: string | null
    eft_proof_image_url: string | null
    eft_customer_note: string | null
    eft_marked_paid_at: string | null
    eft_verified_at: string | null
    created_at: string
    email: string | null
    name: string | null
    image: string | null
    shipping_address1: string | null
    shipping_address2: string | null
    phone: string | null
    pudo_locker_name_user: string | null
    pudo_locker_address_user: string | null
    eft_bank_account_name: string | null
    eft_bank_name: string | null
    eft_bank_account_number: string | null
    eft_bank_branch: string | null
  }>(
    `
      SELECT
        o.id,
        o.user_id,
        o.reference_code,
        o.status,
        o.payment_method,
        o.currency_code,
        o.subtotal_cents,
        o.shipping_cents,
        o.total_cents,
        o.shipping_snapshot_name,
        o.shipping_snapshot_line1,
        o.shipping_snapshot_line2,
        o.delivery_method,
        o.contact_phone,
        o.contact_email,
        o.pudo_locker_name,
        o.pudo_locker_address,
        o.customer_eft_account_name,
        o.customer_eft_bank_name,
        o.customer_eft_account_number,
        o.peach_checkout_id,
        o.peach_resource_path,
        o.eft_proof_image_url,
        o.eft_customer_note,
        o.eft_marked_paid_at,
        o.eft_verified_at,
        o.created_at,
        u.email,
        u.name,
        u.image,
        u.shipping_address1,
        u.shipping_address2,
        u.phone,
        u.pudo_locker_name AS pudo_locker_name_user,
        u.pudo_locker_address AS pudo_locker_address_user,
        u.eft_bank_account_name,
        u.eft_bank_name,
        u.eft_bank_account_number,
        u.eft_bank_branch
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.id = $1
      LIMIT 1
    `,
    [orderId]
  )
  const order = orderRes.rows[0]
  if (!order) return res.status(404).json({ error: 'Order not found' })

  const lines = await runQuery<{
    id: string
    product_id: number | null
    title: string
    unit_price_cents: number
    currency_code: string
    quantity: number
    line_total_cents: number
    image_url: string | null
  }>(
    `
      SELECT id, product_id, title, unit_price_cents, currency_code, quantity, line_total_cents, image_url
      FROM order_line_items
      WHERE order_id = $1
      ORDER BY created_at ASC
    `,
    [orderId]
  )

  const events = await runQuery<{
    id: string
    provider: string
    event_type: string
    status_after: string | null
    external_event_id: string | null
    created_at: string
    payload_json: unknown
  }>(
    `
      SELECT id, provider, event_type, status_after, external_event_id, created_at, payload_json
      FROM order_payment_events
      WHERE order_id = $1
      ORDER BY created_at ASC
    `,
    [orderId]
  )

  return res.status(200).json({
    order: {
      id: order.id,
      userId: order.user_id,
      referenceCode: order.reference_code,
      status: order.status,
      paymentMethod: order.payment_method,
      currencyCode: order.currency_code,
      subtotalCents: order.subtotal_cents,
      shippingCents: order.shipping_cents,
      totalCents: order.total_cents,
      shippingSnapshot: {
        name: order.shipping_snapshot_name,
        line1: order.shipping_snapshot_line1,
        line2: order.shipping_snapshot_line2,
      },
      deliveryMethod: order.delivery_method || 'standard',
      contactPhone: order.contact_phone,
      contactEmail: order.contact_email,
      pudoLockerName: order.pudo_locker_name,
      pudoLockerAddress: order.pudo_locker_address,
      customerEftAccountName: order.customer_eft_account_name,
      customerEftBankName: order.customer_eft_bank_name,
      customerEftAccountNumber: order.customer_eft_account_number,
      peachCheckoutId: order.peach_checkout_id,
      peachResourcePath: order.peach_resource_path,
      eftProofImageUrl: order.eft_proof_image_url,
      eftCustomerNote: order.eft_customer_note,
      eftMarkedPaidAt: order.eft_marked_paid_at,
      eftVerifiedAt: order.eft_verified_at,
      createdAt: order.created_at,
    },
    user: {
      email: order.email,
      name: order.name,
      image: order.image,
      phone: order.phone,
      shippingAddress1: order.shipping_address1,
      shippingAddress2: order.shipping_address2,
      pudoLockerName: order.pudo_locker_name_user,
      pudoLockerAddress: order.pudo_locker_address_user,
      eftBankAccountName: order.eft_bank_account_name,
      eftBankName: order.eft_bank_name,
      eftBankAccountNumber: order.eft_bank_account_number,
      eftBankBranch: order.eft_bank_branch,
    },
    lineItems: lines.rows.map((l) => ({
      id: l.id,
      productId: l.product_id != null ? String(l.product_id) : null,
      title: l.title,
      unitPriceCents: l.unit_price_cents,
      currencyCode: l.currency_code,
      quantity: l.quantity,
      lineTotalCents: l.line_total_cents,
      imageUrl: l.image_url,
    })),
    paymentEvents: events.rows.map((e) => ({
      id: e.id,
      provider: e.provider,
      eventType: e.event_type,
      statusAfter: e.status_after,
      externalEventId: e.external_event_id,
      createdAt: e.created_at,
      payload: e.payload_json,
    })),
  })
})

export default router
