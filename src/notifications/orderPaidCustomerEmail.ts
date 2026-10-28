import { centsToDecimalString } from '../orders/money'

export type CustomerOrderLineItem = {
  title: string
  quantity: number
  unitPriceCents: number
  lineTotalCents: number
}

export type OrderPaidCustomerEmailParams = {
  referenceCode: string
  customerFirstName: string
  paymentMethodLabel: string
  currencyCode: string
  subtotalCents: number
  shippingCents: number
  discountCents: number
  wonderCoinsRedeemed: number
  promoCode: string | null
  promoDiscountCents: number
  totalCents: number
  deliverySummary: string
  paidAt: string
  lineItems: CustomerOrderLineItem[]
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

export function orderPaidCustomerEmailSubject(referenceCode: string): string {
  const ref = String(referenceCode || '').trim() || 'order'
  return `Your Wonderport order — ${ref}`
}

export function buildOrderPaidCustomerEmailText(params: OrderPaidCustomerEmailParams): string {
  const name = params.customerFirstName.trim() || 'there'
  const lines: string[] = [
    `Hi ${name},`,
    '',
    'Thank you for your Wonderport purchase. Your payment was successful.',
    '',
    `Order: ${params.referenceCode}`,
    `Paid: ${params.paidAt}`,
    `Payment method: ${params.paymentMethodLabel}`,
    `Delivery: ${params.deliverySummary}`,
    '',
    'Items',
  ]
  for (const item of params.lineItems) {
    lines.push(
      `  • ${item.title} × ${item.quantity} — ${formatMoney(item.lineTotalCents, params.currencyCode)}`,
    )
  }
  lines.push(
    '',
    `Subtotal: ${formatMoney(params.subtotalCents, params.currencyCode)}`,
    `Shipping: ${formatMoney(params.shippingCents, params.currencyCode)}`,
  )
  if (params.promoDiscountCents > 0) {
    lines.push(
      `${params.promoCode?.trim() || 'Promo'} discount: −${formatMoney(params.promoDiscountCents, params.currencyCode)}`,
    )
  }
  if (params.discountCents > 0) {
    lines.push(
      `WonderCoins: −${formatMoney(params.discountCents, params.currencyCode)}`,
    )
  }
  lines.push(
    `Total paid: ${formatMoney(params.totalCents, params.currencyCode)}`,
    '',
    'If you have any questions, reply to this email or contact info@wonderporthobbies.com.',
    '',
    '— Wonderport',
  )
  return lines.join('\n')
}

export function buildOrderPaidCustomerEmailHtml(params: OrderPaidCustomerEmailParams): string {
  const name = escapeHtml(params.customerFirstName.trim() || 'there')
  const ref = escapeHtml(params.referenceCode)
  const paidAt = escapeHtml(params.paidAt)
  const payment = escapeHtml(params.paymentMethodLabel)
  const delivery = escapeHtml(params.deliverySummary)
  const currency = params.currencyCode

  const itemRows = params.lineItems
    .map((item) => {
      const title = escapeHtml(item.title)
      const line = escapeHtml(formatMoney(item.lineTotalCents, currency))
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#111;">${title}</td>
        <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#666;text-align:center;">${item.quantity}</td>
        <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#111;text-align:right;font-weight:600;">${line}</td>
      </tr>`
    })
    .join('')

  const promoRow =
    params.promoDiscountCents > 0
      ? `<tr>
          <td colspan="2" style="padding:6px 0;text-align:right;color:#666;font-size:14px;">${escapeHtml(params.promoCode?.trim() || 'Promo')}</td>
          <td style="padding:6px 0;text-align:right;color:#16a34a;font-size:14px;">−${escapeHtml(formatMoney(params.promoDiscountCents, currency))}</td>
        </tr>`
      : ''

  const coinsRow =
    params.discountCents > 0
      ? `<tr>
          <td colspan="2" style="padding:6px 0;text-align:right;color:#666;font-size:14px;">WonderCoins</td>
          <td style="padding:6px 0;text-align:right;color:#16a34a;font-size:14px;">−${escapeHtml(formatMoney(params.discountCents, currency))}</td>
        </tr>`
      : ''

  return `
    <div style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f6f4;padding:32px 16px;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px 28px;color:#111;">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#888;">Wonderport</p>
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;line-height:1.3;">Thanks for your order</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#444;">
          Hi ${name}, your payment was successful. Here’s a summary of what you bought.
        </p>

        <div style="background:#fafafa;border-radius:8px;padding:14px 16px;margin:0 0 24px;font-size:14px;">
          <p style="margin:0 0 6px;"><span style="color:#666;">Order</span> <strong>${ref}</strong></p>
          <p style="margin:0 0 6px;"><span style="color:#666;">Paid</span> ${paidAt}</p>
          <p style="margin:0 0 6px;"><span style="color:#666;">Payment</span> ${payment}</p>
          <p style="margin:0;"><span style="color:#666;">Delivery</span> ${delivery}</p>
        </div>

        <table style="width:100%;border-collapse:collapse;margin:0 0 8px;">
          <thead>
            <tr>
              <th style="padding:0 0 8px;text-align:left;font-size:12px;color:#888;font-weight:600;">Item</th>
              <th style="padding:0 0 8px;text-align:center;font-size:12px;color:#888;font-weight:600;">Qty</th>
              <th style="padding:0 0 8px;text-align:right;font-size:12px;color:#888;font-weight:600;">Amount</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
          <tfoot>
            <tr>
              <td colspan="2" style="padding:12px 0 6px;text-align:right;color:#666;font-size:14px;">Subtotal</td>
              <td style="padding:12px 0 6px;text-align:right;font-size:14px;">${escapeHtml(formatMoney(params.subtotalCents, currency))}</td>
            </tr>
            <tr>
              <td colspan="2" style="padding:6px 0;text-align:right;color:#666;font-size:14px;">Shipping</td>
              <td style="padding:6px 0;text-align:right;font-size:14px;">${escapeHtml(formatMoney(params.shippingCents, currency))}</td>
            </tr>
            ${promoRow}
            ${coinsRow}
            <tr>
              <td colspan="2" style="padding:14px 0 0;text-align:right;font-size:16px;font-weight:700;">Total paid</td>
              <td style="padding:14px 0 0;text-align:right;font-size:16px;font-weight:700;">${escapeHtml(formatMoney(params.totalCents, currency))}</td>
            </tr>
          </tfoot>
        </table>

        <p style="margin:28px 0 0;font-size:13px;line-height:1.5;color:#888;">
          Questions? Contact us at
          <a href="mailto:info@wonderporthobbies.com" style="color:#111;">info@wonderporthobbies.com</a>.
        </p>
      </div>
    </div>
  `.trim()
}
