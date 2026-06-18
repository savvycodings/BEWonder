import express from 'express'
import { v2 as cloudinary } from 'cloudinary'
import { getAuthUserFromRequest } from '../auth/session'
import { runQuery } from '../db/client'
import { generateUniqueReferenceCode } from './referenceCode'
import { centsToDecimalString, moneyStringToCents } from './money'
import { isProductInStock, parseTotalInventory, stockFieldsFromRow } from '../products/inventory'
import {
  isValidPudoLockerTier,
  orderHasWholeSetLine,
  pudoLockerTierForSetOnly,
  shippingCentsForOrder,
  type PudoLockerTier,
} from './pudoLockerPricing'
import { createYocoCheckout } from './yocoClient'
import { yocoLog, yocoLogError } from './yocoLog'
import { syncYocoOrderPayment } from './yocoSyncRoute'
import {
  canCustomerAbandonOrder,
  customerOrderHistoryWhereSql,
  isCustomerVisibleOrder,
} from './customerOrderVisibility'
import { quoteOrderCart, type LineInput } from './orderCartPricing'

const router = express.Router()

/** South Africa domestic Pudo locker tiers (order currency must be ZAR). */

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

const ADDRESS_TEXT_PATTERN = /^[a-zA-Z0-9\s,.'#/-]+$/
const PLACE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z\s'.-]*$/

function validateDoorShippingBody(body: Record<string, unknown>): string | null {
  const line1 = String(body.shippingAddress || '').trim()
  const line2 = String(body.shippingAddressLine2 || '').trim()
  const postalCode = String(body.shippingPostalCode || '').trim()
  const city = String(body.shippingCity || '').trim()
  const province = String(body.shippingProvince || '').trim()

  if (!line1 || line1.length < 5 || !ADDRESS_TEXT_PATTERN.test(line1)) {
    return 'Enter a valid street address.'
  }
  if (line2 && !ADDRESS_TEXT_PATTERN.test(line2)) {
    return 'Enter a valid apartment, suite, or unit.'
  }
  if (!/^\d{4}$/.test(postalCode)) {
    return 'Enter a valid 4-digit postal code.'
  }
  if (!city || !PLACE_NAME_PATTERN.test(city)) {
    return 'Enter a valid city name.'
  }
  if (!province || !PLACE_NAME_PATTERN.test(province)) {
    return 'Enter a valid province.'
  }
  return null
}

function formatDoorSnapshotLine2(body: Record<string, unknown>): string {
  const parts = [
    String(body.shippingAddressLine2 || '').trim(),
    String(body.shippingCity || '').trim(),
    String(body.shippingProvince || '').trim(),
    String(body.shippingPostalCode || '').trim(),
  ].filter(Boolean)
  return parts.join(', ')
}

type ProductRow = {
  id: number
  title: string
  thumbnail_url: string | null
  images: unknown
  variant_price: unknown
  variant_currency_code: string | null
  total_inventory: unknown
  available_for_sale: boolean | null
  length_cm: unknown
  width_cm: unknown
  height_cm: unknown
  weight_kg: unknown
  locker_tier: unknown
  variant_length_cm: unknown
  variant_width_cm: unknown
  variant_height_cm: unknown
  variant_weight_kg: unknown
  variant_locker_tier: unknown
}

async function loadProductForOrder(
  productId: string,
  packaging: 'single' | 'set' = 'single',
): Promise<ProductRow | null> {
  const idNum = Number(productId)
  if (!Number.isFinite(idNum)) return null
  const orderDirection = packaging === 'set' ? 'DESC' : 'ASC'
  const result = await runQuery<ProductRow>(
    `
      SELECT
        p.id,
        p.title,
        p.thumbnail_url,
        p.images,
        p.total_inventory,
        p.available_for_sale,
        p.length_cm,
        p.width_cm,
        p.height_cm,
        p.weight_kg,
        p.locker_tier,
        v.price as variant_price,
        v.currency_code as variant_currency_code,
        v.length_cm AS variant_length_cm,
        v.width_cm AS variant_width_cm,
        v.height_cm AS variant_height_cm,
        v.weight_kg AS variant_weight_kg,
        v.locker_tier AS variant_locker_tier
      FROM products p
      LEFT JOIN LATERAL (
        SELECT price, currency_code, length_cm, width_cm, height_cm, weight_kg, locker_tier
        FROM product_variants
        WHERE product_id = p.id
        ORDER BY price ${orderDirection} NULLS LAST
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

router.post('/quote', async (req, res) => {
  try {
    const auth = await getAuthUserFromRequest(req)

    const items = req.body?.items as LineInput[] | undefined
    const pudoLockerTier = String(req.body?.pudoLockerTier || '').trim().toLowerCase()
    const wonderCoinsToRedeem = auth
      ? Math.max(0, Math.floor(Number(req.body?.wonderCoinsToRedeem) || 0))
      : 0

    const result = await quoteOrderCart({
      userId: auth?.userId ?? null,
      items: items || [],
      pudoLockerTier,
      wonderCoinsToRedeem,
    })

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, detail: result.detail })
    }

    return res.status(200).json(result.quote)
  } catch (error) {
    console.error('POST /orders/quote failed', error)
    return res.status(500).json({ error: 'Unable to quote order' })
  }
})

router.post('/', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) return res.status(401).json({ error: 'Unauthorized' })

  const paymentMethod = String(req.body?.paymentMethod || '').toLowerCase()
  if (paymentMethod !== 'yoco' && paymentMethod !== 'eft') {
    return res.status(400).json({ error: 'paymentMethod must be yoco or eft' })
  }

  const items = req.body?.items as LineInput[] | undefined
  const wonderCoinsToRedeem = Math.max(0, Math.floor(Number(req.body?.wonderCoinsToRedeem) || 0))

  const pudoLockerTierRaw = String(req.body?.pudoLockerTier || '').trim().toLowerCase()
  if (!isValidPudoLockerTier(pudoLockerTierRaw)) {
    return res.status(400).json({
      error: 'pudoLockerTier is required (locker or door)',
    })
  }
  const pudoLockerTier = pudoLockerTierRaw as PudoLockerTier

  const quoted = await quoteOrderCart({
    userId: auth.userId,
    items: items || [],
    pudoLockerTier,
    wonderCoinsToRedeem,
  })
  if (!quoted.ok) {
    return res.status(quoted.status).json({ error: quoted.error, detail: quoted.detail })
  }

  const { lines, quote } = quoted
  const subtotal = quote.subtotalCents
  const shippingCents = quote.shippingCents
  const discountCents = quote.discountCents
  const wonderCoinsRedeemed = quote.wonderCoinsRedeemed
  const total = quote.totalCents
  const currency = quote.currency

  const contactPhone = String(req.body?.contactPhone || '').trim()
  const contactEmailRaw = String(req.body?.contactEmail || '').trim().toLowerCase()
  const contactEmail = contactEmailRaw || String(auth.user.email || '').trim().toLowerCase()
  if (!contactPhone) {
    return res.status(400).json({ error: 'contactPhone is required' })
  }
  if (contactPhone.replace(/\D/g, '').length < 9) {
    return res.status(400).json({ error: 'contactPhone must be a valid cellphone number' })
  }
  if (!contactEmail || !isValidEmail(contactEmail)) {
    return res.status(400).json({ error: 'contactEmail must be a valid email address' })
  }

  let pudoLockerName = String(req.body?.pudoLockerName || '').trim()
  let pudoLockerAddress = String(req.body?.pudoLockerAddress || '').trim()
  let shipName = auth.user.fullName || ''
  let ship1 = ''
  let ship2 = ''

  if (pudoLockerTier === 'door') {
    const doorErr = validateDoorShippingBody(req.body || {})
    if (doorErr) {
      return res.status(400).json({ error: doorErr })
    }
    ship1 = String(req.body?.shippingAddress || '').trim()
    ship2 = formatDoorSnapshotLine2(req.body || {})
    pudoLockerName = ''
    pudoLockerAddress = ''
  } else {
    if (!pudoLockerName || !pudoLockerAddress) {
      return res.status(400).json({
        error: 'pudoLockerName and pudoLockerAddress are required for Pudo locker delivery',
      })
    }
    ship1 = `Pudo locker: ${pudoLockerName}`
    ship2 = pudoLockerAddress
  }

  if (orderHasWholeSetLine(lines) && !pudoLockerTierForSetOnly(pudoLockerTier)) {
    return res.status(400).json({
      error: 'Whole set orders require door delivery (R110).',
    })
  }

  const customerEftAccountName = String(req.body?.customerEftAccountName || '').trim()
  const customerEftBankName = String(req.body?.customerEftBankName || '').trim()
  const customerEftAccountNumber = String(req.body?.customerEftAccountNumber || '').trim()

  const deliveryMethod = 'pudo'
  const initialStatus = paymentMethod === 'eft' ? 'awaiting_proof' : 'pending_payment'

  const referenceCode = await generateUniqueReferenceCode()
  const orderPudoName = pudoLockerName || null
  const orderPudoAddr = pudoLockerAddress || null

  const insert = await runQuery<{ id: string }>(
    `
      INSERT INTO orders (
        user_id, reference_code, status, payment_method, currency_code,
        subtotal_cents, discount_cents, wonder_coins_redeemed, shipping_cents, total_cents,
        shipping_snapshot_name, shipping_snapshot_line1, shipping_snapshot_line2,
        delivery_method, contact_phone, contact_email,
        pudo_locker_name, pudo_locker_address, pudo_locker_tier,
        customer_eft_account_name, customer_eft_bank_name, customer_eft_account_number,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16,
        $17, $18, $19,
        $20, $21, $22,
        NOW()
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
      discountCents,
      wonderCoinsRedeemed,
      shippingCents,
      total,
      shipName,
      ship1,
      ship2,
      deliveryMethod,
      contactPhone,
      contactEmail,
      orderPudoName,
      orderPudoAddr,
      pudoLockerTier,
      customerEftAccountName || null,
      customerEftBankName || null,
      customerEftAccountNumber || null,
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
          order_id, product_id, title, unit_price_cents, currency_code, quantity, line_total_cents, image_url, packaging
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        line.packaging,
      ]
    )
  }

  await runQuery(
    `
      INSERT INTO order_payment_events (order_id, provider, event_type, status_after, payload_json)
      VALUES ($1, $2, 'order_created', $3, $4::jsonb)
    `,
    [
      orderId,
      paymentMethod,
      initialStatus,
      JSON.stringify({
        referenceCode,
        totalCents: total,
        subtotalCents: subtotal,
        discountCents,
        wonderCoinsRedeemed,
        deliveryMethod,
        shippingCents,
        contactEmail,
      }),
    ]
  )

  return res.status(201).json({
    orderId,
    referenceCode,
    subtotalCents: subtotal,
    discountCents,
    wonderCoinsRedeemed,
    wonderCoinsEarned: quote.wonderCoinsEarned,
    shippingCents,
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
    preview_image_url: string | null
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
        (
          SELECT oli.image_url
          FROM order_line_items oli
          WHERE oli.order_id = o.id
            AND oli.image_url IS NOT NULL
            AND TRIM(oli.image_url) <> ''
          ORDER BY oli.created_at ASC
          LIMIT 1
        ) AS preview_image_url
      FROM orders o
      WHERE o.user_id = $1
        AND ${customerOrderHistoryWhereSql('o')}
      ORDER BY o.created_at DESC
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
      previewImageUrl: r.preview_image_url,
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
    delivery_method: string | null
    contact_phone: string | null
    contact_email: string | null
    pudo_locker_name: string | null
    pudo_locker_address: string | null
    pudo_locker_tier: string | null
    customer_eft_account_name: string | null
    customer_eft_bank_name: string | null
    customer_eft_account_number: string | null
    yoco_checkout_id: string | null
    eft_proof_image_url: string | null
    eft_customer_note: string | null
    created_at: string
  }>(
    `
      SELECT
        id, reference_code, status, payment_method, currency_code,
        subtotal_cents, shipping_cents, total_cents,
        shipping_snapshot_name, shipping_snapshot_line1, shipping_snapshot_line2,
        delivery_method, contact_phone, contact_email,
        pudo_locker_name, pudo_locker_address, pudo_locker_tier,
        customer_eft_account_name, customer_eft_bank_name, customer_eft_account_number,
        yoco_checkout_id, eft_proof_image_url, eft_customer_note, created_at
      FROM orders
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `,
    [orderId, auth.userId]
  )
  const order = orderRes.rows[0]
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (!isCustomerVisibleOrder(order)) {
    return res.status(404).json({ error: 'Order not found' })
  }

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
      deliveryMethod: order.delivery_method || 'pudo',
      contactPhone: order.contact_phone,
      contactEmail: order.contact_email,
      pudoLockerName: order.pudo_locker_name,
      pudoLockerAddress: order.pudo_locker_address,
      pudoLockerTier: order.pudo_locker_tier,
      customerEftAccountName: order.customer_eft_account_name,
      customerEftBankName: order.customer_eft_bank_name,
      customerEftAccountNumber: order.customer_eft_account_number,
      yocoCheckoutId: order.yoco_checkout_id,
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

router.post('/:orderId/abandon', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) return res.status(401).json({ error: 'Unauthorized' })
  const orderId = String(req.params.orderId || '').trim()
  if (!orderId) return res.status(400).json({ error: 'orderId required' })

  const orderRes = await runQuery<{
    id: string
    status: string
    payment_method: string
    eft_proof_image_url: string | null
  }>(
    `
      SELECT id, status, payment_method, eft_proof_image_url
      FROM orders
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `,
    [orderId, auth.userId]
  )
  const order = orderRes.rows[0]
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (order.status === 'cancelled') {
    return res.status(200).json({ ok: true, alreadyCancelled: true })
  }
  if (!canCustomerAbandonOrder(order)) {
    return res.status(400).json({ error: 'This order cannot be cancelled' })
  }

  await runQuery(
    `
      UPDATE orders
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
    `,
    [orderId]
  )
  await runQuery(
    `
      INSERT INTO order_payment_events (order_id, provider, event_type, status_after, payload_json)
      VALUES ($1, $2, 'checkout_abandoned', 'cancelled', $3::jsonb)
    `,
    [orderId, order.payment_method, JSON.stringify({ reason: 'customer_abandoned' })]
  )

  return res.status(200).json({ ok: true })
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

router.post('/:orderId/yoco/init', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) return res.status(401).json({ error: 'Unauthorized' })
  const orderId = String(req.params.orderId || '').trim()
  yocoLog('POST /orders/:orderId/yoco/init', {
    orderId,
    userId: auth.userId,
    returnBaseUrl: String(req.body?.returnBaseUrl || '').trim() || null,
  })

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
  if (order.payment_method !== 'yoco') {
    return res.status(400).json({ error: 'Order is not a Yoco card payment' })
  }
  if (order.status !== 'pending_payment') {
    return res.status(400).json({ error: 'Order is not awaiting card payment' })
  }

  const returnBaseUrl = String(req.body?.returnBaseUrl || '').trim() || undefined
  const checkout = await createYocoCheckout({
    amountCents: order.total_cents,
    currency: order.currency_code,
    orderId: order.id,
    referenceCode: order.reference_code,
    idempotencyKey: `${order.id}:${Date.now()}`,
    returnBaseUrl,
  })

  if (!checkout.ok) {
    yocoLogError('yoco/init failed for order', {
      orderId,
      referenceCode: order.reference_code,
      httpStatus: checkout.status,
      error: checkout.error,
      yocoBody: checkout.yocoBody,
    })
    const status = checkout.status && checkout.status >= 400 && checkout.status < 500 ? checkout.status : 503
    return res.status(status).json({
      error: checkout.error,
      yocoStatus: checkout.status,
    })
  }

  await runQuery(
    `
      UPDATE orders
      SET yoco_checkout_id = $2, updated_at = NOW()
      WHERE id = $1
    `,
    [orderId, checkout.checkoutId]
  )

  await runQuery(
    `
      INSERT INTO order_payment_events (order_id, provider, event_type, status_after, payload_json)
      VALUES ($1, 'yoco', 'checkout_init', 'pending_payment', $2::jsonb)
    `,
    [orderId, JSON.stringify({ checkoutId: checkout.checkoutId, redirectUrl: checkout.redirectUrl })]
  )

  const amountDecimal = centsToDecimalString(order.total_cents)
  const processingMode = checkout.processingMode || 'unknown'
  yocoLog('yoco/init ok', {
    orderId,
    checkoutId: checkout.checkoutId,
    processingMode,
    totalCents: order.total_cents,
  })
  return res.status(200).json({
    checkoutId: checkout.checkoutId,
    redirectUrl: checkout.redirectUrl,
    amount: amountDecimal,
    currency: order.currency_code,
    referenceCode: order.reference_code,
    processingMode,
    testMode: processingMode === 'test',
    testPaymentHint:
      processingMode === 'test'
        ? 'Choose Card (not Google Pay). Enter exactly: 4111 1111 1111 1111 · Expiry 01/30 · CVC 123. Clear each field first if autofill shows other numbers. Minimum R2.00.'
        : undefined,
  })
})

router.post('/:orderId/yoco/sync', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) return res.status(401).json({ error: 'Unauthorized' })
  const orderId = String(req.params.orderId || '').trim()
  yocoLog('POST /orders/:orderId/yoco/sync', { orderId, userId: auth.userId })
  return syncYocoOrderPayment(auth, orderId, res)
})

export default router
