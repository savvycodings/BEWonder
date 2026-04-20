import express from 'express'
import { v2 as cloudinary } from 'cloudinary'
import { getAuthUserFromRequest } from '../auth/session'
import { runQuery } from '../db/client'
import { generateUniqueReferenceCode } from './referenceCode'
import { centsToDecimalString, moneyStringToCents } from './money'
import { createPeachCheckout, peachPaymentWidgetUrl } from './peachClient'

const router = express.Router()

type LineInput = { productId: string; quantity: number }

type ProductRow = {
  id: number
  title: string
  thumbnail_url: string | null
  images: unknown
  variant_price: unknown
  variant_currency_code: string | null
}

async function loadProductForOrder(productId: string): Promise<ProductRow | null> {
  const idNum = Number(productId)
  if (!Number.isFinite(idNum)) return null
  const result = await runQuery<ProductRow>(
    `
      SELECT
        p.id,
        p.title,
        p.thumbnail_url,
        p.images,
        v.price as variant_price,
        v.currency_code as variant_currency_code
      FROM products p
      LEFT JOIN LATERAL (
        SELECT price, currency_code
        FROM product_variants
        WHERE product_id = p.id
        ORDER BY price ASC NULLS LAST
        LIMIT 1
      ) v ON true
      WHERE p.id = $1
      LIMIT 1
    `,
    [idNum]
  )
  return result.rows[0] || null
}

function featuredImage(row: ProductRow): string | null {
  const images: string[] = Array.isArray(row.images) ? row.images : []
  return row.thumbnail_url || images[0] || null
}

/** Public bank copy for EFT (from env). */
router.get('/eft-instructions', (_req, res) => {
  return res.status(200).json({
    accountName: process.env.EFT_ACCOUNT_NAME || 'WonderPort',
    accountNumber: process.env.EFT_ACCOUNT_NUMBER || '4116973995',
    bank: process.env.EFT_BANK_NAME || 'ABSA',
    branch: process.env.EFT_BRANCH_CODE || '632005',
    message:
      'Use your WonderPort order reference (starts with WP-) in your bank transfer reference so we can match your payment.',
  })
})

router.post('/', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) return res.status(401).json({ error: 'Unauthorized' })

  const paymentMethod = String(req.body?.paymentMethod || '').toLowerCase()
  if (paymentMethod !== 'peach' && paymentMethod !== 'eft') {
    return res.status(400).json({ error: 'paymentMethod must be peach or eft' })
  }

  const items = req.body?.items as LineInput[] | undefined
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items array is required' })
  }
  if (items.length > 30) {
    return res.status(400).json({ error: 'Too many line items' })
  }

  const lines: {
    productId: number | null
    title: string
    unitCents: number
    currency: string
    qty: number
    lineTotal: number
    imageUrl: string | null
  }[] = []

  let currency = ''
  for (const raw of items) {
    const qty = Math.max(1, Math.min(99, Math.floor(Number(raw.quantity) || 0)))
    const row = await loadProductForOrder(String(raw.productId))
    if (!row) {
      return res.status(400).json({ error: `Unknown product: ${raw.productId}` })
    }
    const { cents, currency: cur } = moneyStringToCents(row.variant_price, row.variant_currency_code || 'USD')
    if (cents <= 0) {
      return res.status(400).json({ error: `Product has no price: ${raw.productId}` })
    }
    if (!currency) currency = cur
    else if (cur !== currency) {
      return res.status(400).json({ error: 'Mixed currencies in one order are not supported' })
    }
    const lineTotal = cents * qty
    lines.push({
      productId: row.id,
      title: row.title,
      unitCents: cents,
      currency: cur,
      qty,
      lineTotal,
      imageUrl: featuredImage(row),
    })
  }

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0)
  const shippingCents = 0
  const total = subtotal + shippingCents
  const initialStatus = paymentMethod === 'eft' ? 'awaiting_proof' : 'pending_payment'

  const referenceCode = await generateUniqueReferenceCode()
  const shipName = auth.user.fullName || ''
  const ship1 = auth.user.shippingAddress || null
  const ship2 = null

  const insert = await runQuery<{ id: string }>(
    `
      INSERT INTO orders (
        user_id, reference_code, status, payment_method, currency_code,
        subtotal_cents, shipping_cents, total_cents,
        shipping_snapshot_name, shipping_snapshot_line1, shipping_snapshot_line2,
        peach_merchant_transaction_id, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11,
        $2, NOW()
      )
      RETURNING id
    `,
    [
      auth.userId,
      referenceCode,
      initialStatus,
      paymentMethod,
      currency,
      subtotal,
      shippingCents,
      total,
      shipName,
      ship1,
      ship2,
    ]
  )
  const orderId = insert.rows[0]?.id
  if (!orderId) {
    return res.status(500).json({ error: 'Could not create order' })
  }

  for (const line of lines) {
    await runQuery(
      `
        INSERT INTO order_line_items (
          order_id, product_id, title, unit_price_cents, currency_code, quantity, line_total_cents, image_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        orderId,
        line.productId,
        line.title,
        line.unitCents,
        line.currency,
        line.qty,
        line.lineTotal,
        line.imageUrl,
      ]
    )
  }

  await runQuery(
    `
      INSERT INTO order_payment_events (order_id, provider, event_type, status_after, payload_json)
      VALUES ($1, $2, 'order_created', $3, $4::jsonb)
    `,
    [orderId, paymentMethod, initialStatus, JSON.stringify({ referenceCode, totalCents: total })]
  )

  return res.status(201).json({
    orderId,
    referenceCode,
    totalCents: total,
    currencyCode: currency,
    paymentMethod,
    status: initialStatus,
  })
})

router.get('/mine', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) return res.status(401).json({ error: 'Unauthorized' })

  const result = await runQuery<{
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
      LIMIT 100
    `,
    [auth.userId]
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
    })),
  })
})

router.get('/:orderId', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) return res.status(401).json({ error: 'Unauthorized' })
  const orderId = String(req.params.orderId || '').trim()
  if (!orderId) return res.status(400).json({ error: 'orderId required' })

  const orderRes = await runQuery<{
    id: string
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
    peach_checkout_id: string | null
    eft_proof_image_url: string | null
    eft_customer_note: string | null
    created_at: string
  }>(
    `
      SELECT
        id, reference_code, status, payment_method, currency_code,
        subtotal_cents, shipping_cents, total_cents,
        shipping_snapshot_name, shipping_snapshot_line1, shipping_snapshot_line2,
        peach_checkout_id, eft_proof_image_url, eft_customer_note, created_at
      FROM orders
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `,
    [orderId, auth.userId]
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

  return res.status(200).json({
    order: {
      id: order.id,
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
      peachCheckoutId: order.peach_checkout_id,
      eftProofImageUrl: order.eft_proof_image_url,
      eftCustomerNote: order.eft_customer_note,
      createdAt: order.created_at,
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
  })
})

router.post('/:orderId/eft-proof', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) return res.status(401).json({ error: 'Unauthorized' })
  const orderId = String(req.params.orderId || '').trim()
  const imageBase64 = String(req.body?.imageBase64 || '').trim()
  const mimeType = String(req.body?.mimeType || 'image/jpeg').trim()
  const note = String(req.body?.note || '').trim().slice(0, 2000)

  if (!imageBase64) {
    return res.status(400).json({ error: 'imageBase64 is required' })
  }

  const orderRes = await runQuery<{ id: string; payment_method: string; status: string }>(
    `SELECT id, payment_method, status FROM orders WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [orderId, auth.userId]
  )
  const order = orderRes.rows[0]
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (order.payment_method !== 'eft') {
    return res.status(400).json({ error: 'Order is not EFT' })
  }

  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    return res.status(500).json({ error: 'Upload is not configured' })
  }

  try {
    const uploadResult = await cloudinary.uploader.upload(`data:${mimeType};base64,${imageBase64}`, {
      folder: 'wonderport/order-eft-proofs',
      public_id: `order-${orderId}-${Date.now()}`,
      resource_type: 'image',
    })

    await runQuery(
      `
        UPDATE orders
        SET
          eft_proof_image_url = $2,
          eft_customer_note = COALESCE(NULLIF($3, ''), eft_customer_note),
          eft_marked_paid_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [orderId, uploadResult.secure_url, note || null]
    )

    await runQuery(
      `
        INSERT INTO order_payment_events (order_id, provider, event_type, status_after, payload_json)
        VALUES ($1, 'eft', 'user_proof_upload', $2, $3::jsonb)
      `,
      [orderId, order.status, JSON.stringify({ proofUrl: uploadResult.secure_url, note: note || null })]
    )

    return res.status(200).json({ ok: true, proofUrl: uploadResult.secure_url })
  } catch (e) {
    console.error('[orders/eft-proof]', e)
    return res.status(500).json({ error: 'Upload failed' })
  }
})

router.post('/:orderId/peach/init', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) return res.status(401).json({ error: 'Unauthorized' })
  const orderId = String(req.params.orderId || '').trim()

  const orderRes = await runQuery<{
    id: string
    reference_code: string
    payment_method: string
    status: string
    total_cents: number
    currency_code: string
  }>(
    `
      SELECT id, reference_code, payment_method, status, total_cents, currency_code
      FROM orders
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `,
    [orderId, auth.userId]
  )
  const order = orderRes.rows[0]
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (order.payment_method !== 'peach') {
    return res.status(400).json({ error: 'Order is not Peach' })
  }
  if (order.status !== 'pending_payment') {
    return res.status(400).json({ error: 'Order is not awaiting Peach payment' })
  }

  const amountDecimal = centsToDecimalString(order.total_cents)
  const checkout = await createPeachCheckout({
    amountDecimal,
    currency: order.currency_code,
    merchantTransactionId: order.reference_code,
  })

  if (!checkout.ok) {
    return res.status(503).json({ error: checkout.error })
  }

  await runQuery(
    `
      UPDATE orders
      SET
        peach_checkout_id = $2,
        peach_resource_path = $3,
        updated_at = NOW()
      WHERE id = $1
    `,
    [orderId, checkout.checkoutId, `/v1/checkouts/${checkout.checkoutId}`]
  )

  await runQuery(
    `
      INSERT INTO order_payment_events (order_id, provider, event_type, status_after, payload_json)
      VALUES ($1, 'peach', 'checkout_init', 'pending_payment', $2::jsonb)
    `,
    [orderId, JSON.stringify({ checkoutId: checkout.checkoutId })]
  )

  const widgetUrl = peachPaymentWidgetUrl(checkout.checkoutId)
  return res.status(200).json({
    checkoutId: checkout.checkoutId,
    widgetUrl,
    ndc: checkout.ndc,
    amount: amountDecimal,
    currency: order.currency_code,
    merchantTransactionId: order.reference_code,
  })
})

export default router
