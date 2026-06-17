/** Restock notification email templates (aligned with BACK-IN-STOCK-INTEGRATION.md). */

export function restockEmailSubject(productTitle: string): string {
  const title = String(productTitle || 'Your item').trim() || 'Your item'
  return `${title} is back in stock!`
}

export function buildRestockEmailText(params: {
  userName: string
  productTitle: string
  productUrl: string
  unsubscribeUrl: string
}): string {
  const name = params.userName.trim() || 'there'
  return [
    `Hi ${name},`,
    '',
    `Good news — ${params.productTitle} from your Wonderport favourites is back in stock. Order while you still can!`,
    '',
    `Shop now: ${params.productUrl}`,
    '',
    `Unsubscribe from restock alerts for this product: ${params.unsubscribeUrl}`,
  ].join('\n')
}

export function buildRestockEmailHtml(params: {
  userName: string
  productTitle: string
  productHandle: string
  productId: number
  thumbnailUrl: string | null
  productUrl: string
  unsubscribeUrl: string
}): string {
  const name = escapeHtml(params.userName.trim() || 'there')
  const title = escapeHtml(params.productTitle)
  const productUrl = escapeHtml(params.productUrl)
  const unsubscribeUrl = escapeHtml(params.unsubscribeUrl)
  const thumb = params.thumbnailUrl?.trim()
    ? `<img src="${escapeHtml(params.thumbnailUrl)}" alt="" width="120" height="120" style="display:block;border-radius:12px;object-fit:cover;margin:0 auto 20px;" />`
    : ''

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:28px 20px;color:#111;">
      <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:16px;line-height:1.55;margin:0 0 20px;">
        Good news — <strong>${title}</strong> from your Wonderport favourites is back in stock.
        Order while you still can!
      </p>
      ${thumb}
      <p style="text-align:center;margin:0 0 24px;">
        <a href="${productUrl}" style="display:inline-block;background:#E32828;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;">
          Shop now
        </a>
      </p>
      <p style="font-size:12px;color:#666;line-height:1.5;margin:0;">
        <a href="${unsubscribeUrl}" style="color:#666;">Unsubscribe from restock alerts for this product</a>
      </p>
    </div>
  `.trim()
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildProductUrl(handle: string): string {
  const base = (process.env.WEBSITE_URL || process.env.APP_URL || 'https://wonderporthobbies.com').replace(
    /\/+$/,
    '',
  )
  const safeHandle = encodeURIComponent(String(handle || '').trim())
  return `${base}/products/${safeHandle}`
}

export function buildUnsubscribeUrl(productId: number): string {
  const base = (process.env.WEBSITE_URL || process.env.APP_URL || 'https://wonderporthobbies.com').replace(
    /\/+$/,
    '',
  )
  return `${base}/profile/settings?restock_notify_off=${productId}`
}
