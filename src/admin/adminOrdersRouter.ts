import express from 'express'
import { pool, runQuery } from '../db/client'
import { requireAdmin, signAdminJwt, verifyAdminPassword } from './adminAuth'
import { applySpendLoyaltyForNewlyPaidOrder } from '../orders/orderSpendLoyalty'
import { createTcgShipmentForPaidOrderIfNeeded } from '../orders/tcgFulfillment'
import { tcgConfigReadyForShipment } from '../orders/tcgConfig'

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
    tcg_shipment_id: string | null
    tcg_short_tracking_reference: string | null
    tcg_custom_tracking_reference: string | null
    tcg_shipment_status: string | null
    tcg_last_sync_at: string | null
    tcg_last_error: string | null
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
        o.tcg_shipment_id,
        o.tcg_short_tracking_reference,
        o.tcg_custom_tracking_reference,
        o.tcg_shipment_status,
        o.tcg_last_sync_at,
        o.tcg_last_error,
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
      tcgShipmentId: order.tcg_shipment_id,
      tcgShortTrackingReference: order.tcg_short_tracking_reference,
      tcgCustomTrackingReference: order.tcg_custom_tracking_reference,
      tcgShipmentStatus: order.tcg_shipment_status,
      tcgLastSyncAt: order.tcg_last_sync_at,
      tcgLastError: order.tcg_last_error,
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

/**
 * After reviewing the customer's EFT proof image, mark the order paid, apply spend loyalty,
 * and enqueue ShipLogic shipment creation (same as Peach-paid flow).
 */
router.post('/orders/:orderId/accept-eft', requireAdmin, async (req, res) => {
  const orderId = String(req.params.orderId || '').trim()
  if (!orderId) return res.status(400).json({ error: 'orderId required' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const ores = await client.query<{
      id: string
      user_id: string
      status: string
      payment_method: string
      currency_code: string
      total_cents: number
      eft_proof_image_url: string | null
    }>(
      `
        SELECT id, user_id, status, payment_method, currency_code, total_cents, eft_proof_image_url
        FROM orders
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [orderId]
    )
    const row = ores.rows[0]
    if (!row) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Order not found' })
    }
    if (row.payment_method !== 'eft') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Order is not EFT' })
    }
    if (row.status === 'paid') {
      await client.query('ROLLBACK')
      return res.status(200).json({
        ok: true,
        alreadyPaid: true,
        message: 'Order was already marked paid.',
      })
    }
    if (row.status !== 'awaiting_proof') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Cannot accept EFT for status ${row.status}` })
    }
    if (!row.eft_proof_image_url) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Customer has not uploaded proof of payment yet.' })
    }

    const upd = await client.query<{ id: string }>(
      `
        UPDATE orders
        SET
          status = 'paid',
          eft_verified_at = NOW(),
          updated_at = NOW()
        WHERE id = $1::uuid
          AND payment_method = 'eft'
          AND status = 'awaiting_proof'
          AND eft_proof_image_url IS NOT NULL
        RETURNING id
      `,
      [orderId]
    )
    if (!upd.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Could not update order (state changed).' })
    }

    await client.query(
      `
        INSERT INTO order_payment_events (order_id, provider, event_type, status_after, payload_json)
        VALUES ($1, 'eft', 'admin_accept_proof', 'paid', $2::jsonb)
      `,
      [orderId, JSON.stringify({ verifiedAt: new Date().toISOString() })]
    )

    await applySpendLoyaltyForNewlyPaidOrder(client, {
      orderId: row.id,
      userId: row.user_id,
      currencyCode: row.currency_code,
      totalCents: row.total_cents,
    })

    await client.query('COMMIT')

    void createTcgShipmentForPaidOrderIfNeeded(orderId).catch((err) =>
      console.error('[tcg] EFT accept: shipment create failed', orderId, err)
    )

    return res.status(200).json({
      ok: true,
      status: 'paid',
      message:
        'Payment accepted. Courier / waybill booking runs in the background when ShipLogic (TCG) is enabled and configured.',
    })
  } catch (e: any) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    console.error('[admin/accept-eft]', e)
    return res.status(500).json({ error: 'Failed to accept proof' })
  } finally {
    client.release()
  }
})

/**
 * Manually (re)run ShipLogic booking for a **paid** order that has no `tcg_shipment_id` yet
 * (e.g. TCG was off at payment time, or the first attempt failed). Idempotent if already booked.
 */
router.post('/orders/:orderId/book-courier', requireAdmin, async (req, res) => {
  const orderId = String(req.params.orderId || '').trim()
  if (!orderId) return res.status(400).json({ error: 'orderId required' })

  if (!tcgConfigReadyForShipment()) {
    return res.status(400).json({
      error: 'ShipLogic (TCG) is not ready',
      detail:
        'Set TCG_ENABLED=true, TCG_API_BASE_URL, TCG_API_KEY, TCG_COLLECTION_ADDRESS_JSON, and TCG_COLLECTION_CONTACT_JSON on the server.',
    })
  }

  const cur = await runQuery<{ status: string; tcg_shipment_id: string | null }>(
    `SELECT status, tcg_shipment_id FROM orders WHERE id = $1::uuid LIMIT 1`,
    [orderId]
  )
  const row = cur.rows[0]
  if (!row) return res.status(404).json({ error: 'Order not found' })
  if (row.status !== 'paid') {
    return res.status(400).json({ error: 'Order must be paid before booking the courier / waybill.' })
  }
  if (row.tcg_shipment_id) {
    return res.status(200).json({
      ok: true,
      alreadyBooked: true,
      tcgShipmentId: row.tcg_shipment_id,
      message: 'This order already has a courier booking.',
    })
  }

  await createTcgShipmentForPaidOrderIfNeeded(orderId)

  const after = await runQuery<{
    tcg_shipment_id: string | null
    tcg_short_tracking_reference: string | null
    tcg_custom_tracking_reference: string | null
    tcg_shipment_status: string | null
    tcg_last_error: string | null
  }>(
    `
      SELECT tcg_shipment_id, tcg_short_tracking_reference, tcg_custom_tracking_reference,
             tcg_shipment_status, tcg_last_error
      FROM orders WHERE id = $1::uuid LIMIT 1
    `,
    [orderId]
  )
  const a = after.rows[0]
  return res.status(200).json({
    ok: true,
    tcgShipmentId: a?.tcg_shipment_id ?? null,
    tcgShortTrackingReference: a?.tcg_short_tracking_reference ?? null,
    tcgCustomTrackingReference: a?.tcg_custom_tracking_reference ?? null,
    tcgShipmentStatus: a?.tcg_shipment_status ?? null,
    tcgLastError: a?.tcg_last_error ?? null,
    message: a?.tcg_shipment_id
      ? 'Courier booking created. Use short tracking reference as your waybill reference where applicable.'
      : a?.tcg_last_error
        ? 'Booking did not complete; see tcgLastError.'
        : 'No booking was created (check server logs and ShipLogic env).',
  })
})

router.get('/community/reports', requireAdmin, async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
  const status = String(req.query.status || 'open').trim().toLowerCase()
  const useAll = status === 'all'

  const params: unknown[] = [limit]
  const where = useAll ? '' : `WHERE r.status = $2`
  if (!useAll) params.push(status === 'resolved' ? 'resolved' : 'open')

  try {
    const result = await runQuery<{
      id: string
      message_id: string
      reported_by_user_id: string
      reported_user_id: string
      reason: string | null
      status: string
      created_at: string
      resolved_at: string | null
      body: string | null
      image_url: string | null
      reporter_name: string | null
      reporter_email: string | null
      reported_name: string | null
      reported_email: string | null
    }>(
      `
        SELECT
          r.id,
          r.message_id,
          r.reported_by_user_id,
          r.reported_user_id,
          r.reason,
          r.status,
          r.created_at,
          r.resolved_at,
          m.body,
          m.image_url,
          ru.name AS reporter_name,
          ru.email AS reporter_email,
          tu.name AS reported_name,
          tu.email AS reported_email
        FROM community_message_reports r
        LEFT JOIN community_messages m ON m.id = r.message_id
        LEFT JOIN users ru ON ru.id = r.reported_by_user_id
        LEFT JOIN users tu ON tu.id = r.reported_user_id
        ${where}
        ORDER BY r.created_at DESC
        LIMIT $1
      `,
      params
    )

    return res.status(200).json({
      reports: result.rows.map((r) => ({
        id: r.id,
        messageId: r.message_id,
        reportedByUserId: r.reported_by_user_id,
        reportedUserId: r.reported_user_id,
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
        messageBody: r.body || '',
        messageImageUrl: r.image_url || null,
        messageMissing: r.body == null && r.image_url == null,
        reporterName: r.reporter_name,
        reporterEmail: r.reporter_email,
        reportedName: r.reported_name,
        reportedEmail: r.reported_email,
      })),
    })
  } catch (error: any) {
    if (error?.code === '42P01') {
      return res.status(501).json({
        error: 'Community reports are not enabled on this database yet.',
      })
    }
    throw error
  }
})

router.post('/community/reports/:reportId/dismiss', requireAdmin, async (req, res) => {
  const reportId = String(req.params.reportId || '').trim()
  if (!reportId) return res.status(400).json({ error: 'reportId required' })

  try {
    await runQuery(
      `
        UPDATE community_message_reports
        SET status = 'resolved', resolved_at = NOW(), resolved_by_admin = 'admin'
        WHERE id = $1::uuid
      `,
      [reportId]
    )
    return res.status(200).json({ ok: true })
  } catch (error: any) {
    if (error?.code === '42P01') {
      return res.status(501).json({
        error: 'Community reports are not enabled on this database yet.',
      })
    }
    throw error
  }
})

router.post('/community/reports/:reportId/delete-message', requireAdmin, async (req, res) => {
  const reportId = String(req.params.reportId || '').trim()
  if (!reportId) return res.status(400).json({ error: 'reportId required' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const reportRes = await client.query<{ id: string; message_id: string }>(
      `
        SELECT id, message_id
        FROM community_message_reports
        WHERE id = $1::uuid
        LIMIT 1
        FOR UPDATE
      `,
      [reportId]
    )
    const report = reportRes.rows[0]
    if (!report) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Report not found' })
    }

    const deleted = await client.query<{ id: string }>(
      `
        DELETE FROM community_messages
        WHERE id = $1::uuid
        RETURNING id
      `,
      [report.message_id]
    )

    await client.query(
      `
        UPDATE community_message_reports
        SET status = 'resolved', resolved_at = NOW(), resolved_by_admin = 'admin'
        WHERE id = $1::uuid
      `,
      [reportId]
    )

    await client.query('COMMIT')
    return res.status(200).json({ ok: true, deleted: Boolean(deleted.rows[0]) })
  } catch (error: any) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    if (error?.code === '42P01') {
      return res.status(501).json({
        error: 'Community reports are not enabled on this database yet.',
      })
    }
    throw error
  } finally {
    client.release()
  }
})

export default router
