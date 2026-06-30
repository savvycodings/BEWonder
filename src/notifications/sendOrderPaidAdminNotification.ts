import { isResendConfigured, sendAuthEmail } from '../auth/resendMail'
import { pool } from '../db/client'
import { centsToDecimalString } from '../orders/money'
import { pudoLockerTierLabel } from '../orders/pudoLockerPricing'
import {
  buildOrderPaidAdminEmailHtml,
  buildOrderPaidAdminEmailText,
  orderPaidAdminEmailSubject,
  type OrderPaidAdminEmailParams,
  type OrderLineItemEmailRow,
} from './orderPaidAdminEmail'

function adminNotifyEmail(): string {
  return (
    process.env.ORDER_ADMIN_NOTIFY_EMAIL?.trim() || 'info@wonderporthobbies.com'
  )
}

function paymentMethodLabel(method: string): string {
  const m = String(method || '').trim().toLowerCase()
  if (m === 'yoco') return 'Card (Yoco)'
  if (m === 'eft') return 'EFT / Bank transfer'
  if (m === 'peach') return 'Peach Payments'
  return m ? m.toUpperCase() : 'Unknown'
}

function buildDeliverySummary(order: {
  pudo_locker_name: string | null
  pudo_locker_address: string | null
  pudo_locker_tier: string | null
  shipping_snapshot_line1: string | null
  shipping_snapshot_line2: string | null
}): string {
  const lockerName = String(order.pudo_locker_name || '').trim()
  const lockerAddr = String(order.pudo_locker_address || '').trim()
  if (lockerName || lockerAddr) {
    const tier = pudoLockerTierLabel(order.pudo_locker_tier)
    const parts = [tier !== '—' ? tier : null, lockerName, lockerAddr].filter(Boolean)
    return parts.join(' · ') || 'Pudo locker'
  }
  const line1 = String(order.shipping_snapshot_line1 || '').trim()
  const line2 = String(order.shipping_snapshot_line2 || '').trim()
  if (line1 || line2) {
    return [line1, line2].filter(Boolean).join(', ')
  }
  return '—'
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
  total_cents: number
  shipping_snapshot_name: string | null
  shipping_snapshot_line1: string | null
  shipping_snapshot_line2: string | null
  contact_phone: string | null
  contact_email: string | null
  pudo_locker_name: string | null
  pudo_locker_address: string | null
  pudo_locker_tier: string | null
  updated_at: string
  user_name: string | null
  user_email: string | null
}

async function loadOrderForAdminEmail(orderId: string): Promise<{
  order: OrderRow
  lineItems: OrderLineItemEmailRow[]
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
        o.total_cents,
        o.shipping_snapshot_name,
        o.shipping_snapshot_line1,
        o.shipping_snapshot_line2,
        o.contact_phone,
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
    console.warn('[order-paid-admin-email] skip — order not paid', { orderId, status: order.status })
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

  const lineItems: OrderLineItemEmailRow[] = linesRes.rows.map((row) => ({
    title: row.title,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
  }))

  return { order, lineItems }
}

function toEmailParams(order: OrderRow, lineItems: OrderLineItemEmailRow[]): OrderPaidAdminEmailParams {
  const customerName =
    String(order.shipping_snapshot_name || order.user_name || '').trim() || 'Customer'
  const customerEmail =
    String(order.contact_email || order.user_email || '').trim() || '—'

  return {
    referenceCode: order.reference_code,
    customerName,
    customerEmail,
    customerPhone: order.contact_phone,
    paymentMethodLabel: paymentMethodLabel(order.payment_method),
    currencyCode: order.currency_code || 'ZAR',
    subtotalCents: order.subtotal_cents,
    shippingCents: order.shipping_cents,
    discountCents: order.discount_cents,
    wonderCoinsRedeemed: order.wonder_coins_redeemed,
    totalCents: order.total_cents,
    deliverySummary: buildDeliverySummary(order),
    paidAt: formatPaidAt(order.updated_at),
    lineItems,
  }
}

async function clearAdminNotifySentAt(orderId: string): Promise<void> {
  await pool.query(
    `UPDATE orders SET admin_purchase_notify_sent_at = NULL WHERE id = $1::uuid`,
    [orderId],
  )
}

/** Notify shop admin when an order becomes paid (Yoco or EFT). Idempotent per order. */
export async function sendOrderPaidAdminNotification(orderId: string): Promise<void> {
  if (!isResendConfigured()) {
    console.warn('[order-paid-admin-email] Resend not configured — skipping', { orderId })
    return
  }

  const loaded = await loadOrderForAdminEmail(orderId)
  if (!loaded) return

  const claim = await pool.query<{ id: string }>(
    `
      UPDATE orders
      SET admin_purchase_notify_sent_at = NOW()
      WHERE id = $1::uuid
        AND status = 'paid'
        AND admin_purchase_notify_sent_at IS NULL
      RETURNING id
    `,
    [orderId],
  )
  if (!claim.rows[0]) {
    return
  }

  const params = toEmailParams(loaded.order, loaded.lineItems)
  const to = adminNotifyEmail()
  const subject = orderPaidAdminEmailSubject(params.referenceCode)
  const text = buildOrderPaidAdminEmailText(params)
  const html = buildOrderPaidAdminEmailHtml(params)

  const result = await sendAuthEmail({ to, subject, text, html })

  if (result.sent) {
    console.log('[order-paid-admin-email] sent', {
      orderId,
      referenceCode: params.referenceCode,
      to,
      total: `R${centsToDecimalString(params.totalCents)}`,
    })
    return
  }

  await clearAdminNotifySentAt(orderId)
  console.error('[order-paid-admin-email] send failed', {
    orderId,
    referenceCode: params.referenceCode,
    error: result.resendError,
  })
}
