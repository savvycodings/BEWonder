import 'dotenv/config'
import pg from 'pg'
import { sendAuthEmail } from '../dist/auth/resendMail.js'
import {
  buildProductUrl,
  buildRestockEmailHtml,
  buildRestockEmailText,
  buildUnsubscribeUrl,
  restockEmailSubject,
} from '../dist/notifications/restockEmail.js'

const TEST_TO = process.argv[2] || 'kaidenmcintosh27@gmail.com'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  const productRes = await pool.query(`
    SELECT id, handle, title, thumbnail_url
    FROM products
    WHERE is_active = true
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  `)
  const product = productRes.rows[0]
  if (!product) {
    throw new Error('No active product found in database for sample email')
  }

  const userName = 'Kaiden'
  const productTitle = product.title
  const productUrl = buildProductUrl(product.handle)
  const unsubscribeUrl = buildUnsubscribeUrl(product.id)

  const subject = restockEmailSubject(productTitle)
  const text = buildRestockEmailText({ userName, productTitle, productUrl, unsubscribeUrl })
  const html = buildRestockEmailHtml({
    userName,
    productTitle,
    productHandle: product.handle,
    productId: product.id,
    thumbnailUrl: product.thumbnail_url,
    productUrl,
    unsubscribeUrl,
  })

  console.log(`Sending test restock email to ${TEST_TO}`)
  console.log(`Subject: ${subject}`)
  console.log(`Product: ${productTitle} (${product.handle})`)

  const result = await sendAuthEmail({ to: TEST_TO, subject, text, html })

  if (result.sent) {
    console.log('Email sent successfully.')
  } else {
    console.error('Email was not sent.', result.resendError || result)
    process.exitCode = 1
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
