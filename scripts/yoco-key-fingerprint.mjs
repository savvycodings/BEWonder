/**
 * Prints a safe fingerprint of YOCO_SECRET_KEY from .env (no full secret).
 * Use this to compare local / website keys with Railway logs:
 *   [yoco] createCheckout start {"keyMode":"live","key":"sk_live_…xxxx",...}
 *
 * Also probes Yoco create-checkout + hosted page for the "Payment unavailable" block.
 *
 * Usage: node scripts/yoco-key-fingerprint.mjs
 */
import 'dotenv/config'

const key = (process.env.YOCO_SECRET_KEY || '').trim()
if (!key) {
  console.error('YOCO_SECRET_KEY is missing in env')
  process.exit(1)
}

const mode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'unknown'
const fingerprint = key.length < 12 ? '(too short)' : `${key.slice(0, 8)}…${key.slice(-4)}`
console.log('keyMode', mode)
console.log('keyFingerprint', fingerprint)
console.log('')
console.log('Railway: set YOCO_SECRET_KEY to the SAME live secret the website uses,')
console.log('then redeploy. Confirm logs show this fingerprint after an app checkout.')
console.log('After deploy, GET https://bewonder-production.up.railway.app/health/payments')
console.log('should return the same keyFingerprint.')

const res = await fetch('https://payments.yoco.com/api/checkouts', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': `fp-${Date.now()}`,
  },
  body: JSON.stringify({
    amount: 200,
    currency: 'ZAR',
    clientReferenceId: `FP-${Date.now()}`,
  }),
})
const json = await res.json().catch(() => ({}))
console.log('')
console.log('yocoCreateHttp', res.status)
console.log('processingMode', json.processingMode || null)
console.log('redirectUrl', json.redirectUrl || null)

if (json.redirectUrl) {
  const page = await fetch(json.redirectUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  const html = await page.text()
  const lower = html.toLowerCase()
  const blocked = [
    'payment unavailable',
    "can't take online payments",
    'cannot take online payments',
    'online payments yet',
  ].some((s) => lower.includes(s))
  const title = (html.match(/<title[^>]*>([^<]*)/i) || [])[1] || ''
  console.log('hostedPageBlocked', blocked)
  console.log('hostedPageTitle', title.trim())
  if (blocked) {
    console.error('')
    console.error('This key creates checkouts but Yoco blocks the merchant for online pay.')
    console.error('Use the website production YOCO_SECRET_KEY on Railway instead.')
    process.exitCode = 2
  } else {
    console.log('')
    console.log('Hosted page looks usable for this key — Railway must use this same secret.')
  }
}
