import { centsToDecimalString } from '../orders/money'

export type OrderLineItemEmailRow = {
  title: string
  quantity: number
  unitPriceCents: number
  lineTotalCents: number
}

export type OrderPaidAdminEmailParams = {
  referenceCode: string
  customerName: string
  customerEmail: string
  customerPhone: string | null
  paymentMethodLabel: string
  currencyCode: string
  subtotalCents: number
  shippingCents: number
  discountCents: number
  wonderCoinsRedeemed: number
  totalCents: number
  deliverySummary: string
  paidAt: string
  lineItems: OrderLineItemEmailRow[]
}

function formatMoney(cents: number, currencyCode: string): string {
  const amount = centsToDecimalString(cents)
  const code = String(currencyCode || 'ZAR').trim().toUpperCase()
  if (code === 'ZAR') return `R${amount}`
  return `${code} ${amount}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function orderPaidAdminEmailSubject(referenceCode: string): string {
  const ref = String(referenceCode || '').trim() || 'order'
  return `New Wonderport order — ${ref}`
}

export function buildOrderPaidAdminEmailText(params: OrderPaidAdminEmailParams): string {
  const lines: string[] = [
    'A new Wonderport order has been paid.',
    '',
    `Reference: ${params.referenceCode}`,
    `Paid at: ${params.paidAt}`,
    `Payment: ${params.paymentMethodLabel}`,
    '',
    'Customer',
    `  Name: ${params.customerName}`,
    `  Email: ${params.customerEmail}`,
  ]
  if (params.customerPhone?.trim()) {
    lines.push(`  Phone: ${params.customerPhone.trim()}`)
  }
  lines.push('', 'Delivery', `  ${params.deliverySummary}`, '', 'Items')
  for (const item of params.lineItems) {
    lines.push(
      `  • ${item.title} × ${item.quantity} — ${formatMoney(item.lineTotalCents, params.currencyCode)} (${formatMoney(item.unitPriceCents, params.currencyCode)} each)`,
    )
  }
  lines.push(
    '',
    `Subtotal: ${formatMoney(params.subtotalCents, params.currencyCode)}`,
    `Shipping: ${formatMoney(params.shippingCents, params.currencyCode)}`,
  )
  if (params.discountCents > 0) {
    lines.push(`WonderCoins discount: −${formatMoney(params.discountCents, params.currencyCode)} (${params.wonderCoinsRedeemed} coins)`)
  }
  lines.push(`Total: ${formatMoney(params.totalCents, params.currencyCode)}`, '', '— Wonderport')
  return lines.join('\n')
}

export function buildOrderPaidAdminEmailHtml(params: OrderPaidAdminEmailParams): string {
  const ref = escapeHtml(params.referenceCode)
  const name = escapeHtml(params.customerName)
  const email = escapeHtml(params.customerEmail)
  const phone = params.customerPhone?.trim() ? escapeHtml(params.customerPhone.trim()) : ''
  const payment = escapeHtml(params.paymentMethodLabel)
  const paidAt = escapeHtml(params.paidAt)
  const delivery = escapeHtml(params.deliverySummary)
  const currency = params.currencyCode

  const itemRows = params.lineItems
    .map((item) => {
      const title = escapeHtml(item.title)
      const qty = item.quantity
      const unit = escapeHtml(formatMoney(item.unitPriceCents, currency))
      const line = escapeHtml(formatMoney(item.lineTotalCents, currency))
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${title}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${qty}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${unit}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${line}</td>
      </tr>`
    })
    .join('')

  const discountRow =
    params.discountCents > 0
      ? `<tr>
          <td colspan="3" style="padding:6px 12px;text-align:right;color:#444;">WonderCoins discount (${params.wonderCoinsRedeemed} coins)</td>
          <td style="padding:6px 12px;text-align:right;color:#E32828;">−${escapeHtml(formatMoney(params.discountCents, currency))}</td>
        </tr>`
      : ''

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:28px 20px;color:#111;">
      <p style="font-size:20px;font-weight:700;margin:0 0 8px;">New order paid</p>
      <p style="font-size:14px;color:#555;margin:0 0 20px;">Reference <strong>${ref}</strong> · ${paidAt}</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:14px;">
        <tr><td style="padding:4px 0;color:#666;width:120px;">Payment</td><td style="padding:4px 0;">${payment}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Customer</td><td style="padding:4px 0;">${name}</td></tr>
        <tr><td style="padding:4px 0;color:#666;">Email</td><td style="padding:4px 0;"><a href="mailto:${email}" style="color:#E32828;">${email}</a></td></tr>
        ${phone ? `<tr><td style="padding:4px 0;color:#666;">Phone</td><td style="padding:4px 0;">${phone}</td></tr>` : ''}
        <tr><td style="padding:4px 0;color:#666;vertical-align:top;">Delivery</td><td style="padding:4px 0;">${delivery}</td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 16px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px 12px;text-align:left;font-weight:600;">Product</th>
            <th style="padding:8px 12px;text-align:center;font-weight:600;">Qty</th>
            <th style="padding:8px 12px;text-align:right;font-weight:600;">Unit</th>
            <th style="padding:8px 12px;text-align:right;font-weight:600;">Line</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="padding:8px 12px;text-align:right;color:#444;">Subtotal</td>
            <td style="padding:8px 12px;text-align:right;">${escapeHtml(formatMoney(params.subtotalCents, currency))}</td>
          </tr>
          <tr>
            <td colspan="3" style="padding:6px 12px;text-align:right;color:#444;">Shipping</td>
            <td style="padding:6px 12px;text-align:right;">${escapeHtml(formatMoney(params.shippingCents, currency))}</td>
          </tr>
          ${discountRow}
          <tr>
            <td colspan="3" style="padding:10px 12px;text-align:right;font-weight:700;font-size:16px;">Total</td>
            <td style="padding:10px 12px;text-align:right;font-weight:700;font-size:16px;color:#E32828;">${escapeHtml(formatMoney(params.totalCents, currency))}</td>
          </tr>
        </tfoot>
      </table>
      <p style="font-size:12px;color:#888;margin:0;">Wonderport · info@wonderporthobbies.com</p>
    </div>
  `.trim()
}
