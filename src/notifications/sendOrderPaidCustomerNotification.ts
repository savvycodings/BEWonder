import { isResendConfigured, sendAuthEmail } from '../auth/resendMail'
import { pool } from '../db/client'
import { centsToDecimalString } from '../orders/money'
import { pudoLockerTierLabel } from '../orders/pudoLockerPricing'
import {
  buildOrderPaidCustomerEmailHtml,
  buildOrderPaidCustomerEmailText,
  orderPaidCustomerEmailSubject,
  type CustomerOrderLineItem,
  type OrderPaidCustomerEmailParams,
} from './orderPaidCustomerEmail'

function paymentMethodLabel(method: string): string {
  const m = String(method || '').trim().toLowerCase()
  if (m === 'yoco') return 'Card'
  if (m === 'eft') return 'EFT / Bank transfer'
  if (m === 'peach') return 'Card'
  return m ? m.toUpperCase() : 'Payment'
}

/** Delivery blurb for the buyer; no phone, bank, or internal ids. */
function buildDeliverySummary(order: {
  pudo_locker_name: string | null
  pudo_locker_address: string | null
  pudo_locker_tier: string | null
  shipping_snapshot_line1: string | null
  shipping_snapshot_line2: string | null
}): string {
  const tierKey = String(order.pudo_locker_tier || '').trim().toLowerCase()
  const line1 = String(order.shipping_snapshot_line1 || '').trim()
  const line2 = String(order.shipping_snapshot_line2 || '').trim()
  if (tierKey === 'collect') {
    const parts = [pudoLockerTierLabel('collect'), line1, line2].filter(Boolean)
    return parts.join(' · ') || 'Collect (free)'
  }
  const lockerName = String(order.pudo_locker_name || '').trim()
  const lockerAddr = String(order.pudo_locker_address || '').trim()
  if (lockerName || lockerAddr) {
    const tier = pudoLockerTierLabel(order.pudo_locker_tier)
    const parts = [tier !== '-' ? tier : 'Pudo locker', lockerName, lockerAddr].filter(Boolean)
    return parts.join(' · ')
  }
  const parts = [line1, line2].filter(Boolean)
  if (parts.length) return parts.join(', ')
  return 'Delivery details on your order'
}

function formatPaidAt(iso: string | null | undefined): string {
  if (!iso) return new Date().toISOString()
  try {
    return new Date(iso).toLocaleString('en-ZA', {
      timeZone: 'Africa/Johannesburg',
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return String(iso)
  }
}

function firstNameFrom(fullName: string | null | undefined): string {
  const part = String(fullName || '')
    .trim()
    .split(/\s+/)[0]
  return part || 'there'
}

function isSendableCustomerEmail(email: string): boolean {
  const e = email.trim().toLowerCase()
  if (!e || !e.includes('@')) return false
  if (e.endsWith('@deleted.wonderport.local')) return false
  if (e.startsWith('deleted-')) return false
  return true
}

type OrderRow = {
  id: string
  reference_code: string
  status: string
  payment_method: string
  currency_code: string
  subtotal_cents: number
  shipping_cents: number
  discount_cents: number
  wonder_coins_redeemed: number
  promo_code: string | null
  promo_discount_cents: number
  total_cents: number
  shipping_snapshot_name: string | null
  shipping_snapshot_line1: string | null
  shipping_snapshot_line2: string | null
  contact_email: string | null
  pudo_locker_name: string | null
  pudo_locker_address: string | null
  pudo_locker_tier: string | null
  updated_at: string
  user_name: string | null
  user_email: string | null
}

async function loadOrderForCustomerEmail(orderId: string): Promise<{
  order: OrderRow
  lineItems: CustomerOrderLineItem[]
  toEmail: string
} | null> {
  const orderRes = await pool.query<OrderRow>(
    `
      SELECT
        o.id,
        o.reference_code,
        o.status,
        o.payment_method,
        o.currency_code,
        o.subtotal_cents,
        o.shipping_cents,
        COALESCE(o.discount_cents, 0)::int AS discount_cents,
        COALESCE(o.wonder_coins_redeemed, 0)::int AS wonder_coins_redeemed,
        o.promo_code,
        COALESCE(o.promo_discount_cents, 0)::int AS promo_discount_cents,
        o.total_cents,
        o.shipping_snapshot_name,
        o.shipping_snapshot_line1,
        o.shipping_snapshot_line2,
        o.contact_email,
        o.pudo_locker_name,
        o.pudo_locker_address,
        o.pudo_locker_tier,
        o.updated_at,
        u.name AS user_name,
        u.email AS user_email
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.id = $1::uuid
      LIMIT 1
    `,
    [orderId],
  )
  const order = orderRes.rows[0]
  if (!order) return null
  if (order.status !== 'paid') {
    console.warn('[order-paid-customer-email] skip — order not paid', {
      orderId,
      status: order.status,
    })
    return null
  }

  const toEmail = String(order.contact_email || order.user_email || '').trim()
  if (!isSendableCustomerEmail(toEmail)) {
    console.warn('[order-paid-customer-email] skip — no valid customer email', { orderId })
    return null
  }

  const linesRes = await pool.query<{
    title: string
    quantity: number
    unit_price_cents: number
    line_total_cents: number
  }>(
    `
      SELECT title, quantity, unit_price_cents, line_total_cents
      FROM order_line_items
      WHERE order_id = $1::uuid
      ORDER BY created_at ASC
    `,
    [orderId],
  )

  const lineItems: CustomerOrderLineItem[] = linesRes.rows.map((row) => ({
    title: row.title,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
  }))

  return { order, lineItems, toEmail }
}

function toEmailParams(order: OrderRow, lineItems: CustomerOrderLineItem[]): OrderPaidCustomerEmailParams {
  return {
    referenceCode: order.reference_code,
    customerFirstName: firstNameFrom(order.shipping_snapshot_name || order.user_name),
    paymentMethodLabel: paymentMethodLabel(order.payment_method),
    currencyCode: order.currency_code || 'ZAR',
    subtotalCents: order.subtotal_cents,
    shippingCents: order.shipping_cents,
    discountCents: order.discount_cents,
    wonderCoinsRedeemed: order.wonder_coins_redeemed,
    promoCode: order.promo_code,
    promoDiscountCents: order.promo_discount_cents,
    totalCents: order.total_cents,
    deliverySummary: buildDeliverySummary(order),
    paidAt: formatPaidAt(order.updated_at),
    lineItems,
  }
}

async function clearCustomerNotifySentAt(orderId: string): Promise<void> {
  await pool.query(
    `UPDATE orders SET customer_purchase_notify_sent_at = NULL WHERE id = $1::uuid`,
    [orderId],
  )
}

/** Email the buyer a clean receipt when the order first becomes paid. Idempotent. */
export async function sendOrderPaidCustomerNotification(orderId: string): Promise<void> {
  if (!isResendConfigured()) {
    console.warn('[order-paid-customer-email] Resend not configured — skipping', { orderId })
    return
  }

  const loaded = await loadOrderForCustomerEmail(orderId)
  if (!loaded) return

  const claim = await pool.query<{ id: string }>(
    `
      UPDATE orders
      SET customer_purchase_notify_sent_at = NOW()
      WHERE id = $1::uuid
        AND status = 'paid'
        AND customer_purchase_notify_sent_at IS NULL
      RETURNING id
    `,
    [orderId],
  )
  if (!claim.rows[0]) {
    return
  }

  const params = toEmailParams(loaded.order, loaded.lineItems)
  const subject = orderPaidCustomerEmailSubject(params.referenceCode)
  const text = buildOrderPaidCustomerEmailText(params)
  const html = buildOrderPaidCustomerEmailHtml(params)

  const result = await sendAuthEmail({ to: loaded.toEmail, subject, text, html })

  if (result.sent) {
    console.log('[order-paid-customer-email] sent', {
      orderId,
      referenceCode: params.referenceCode,
      to: loaded.toEmail,
      total: `R${centsToDecimalString(params.totalCents)}`,
    })
    return
  }

  await clearCustomerNotifySentAt(orderId)
  console.error('[order-paid-customer-email] send failed', {
    orderId,
    referenceCode: params.referenceCode,
    error: result.resendError,
  })
}
