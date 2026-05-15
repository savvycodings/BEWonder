import 'dotenv/config'
import express from 'express'
import fs from 'fs'
import path from 'path'
import chatRouter from './chat/chatRouter'
import imagesRouter from './images/imagesRouter'
import authRouter from './auth/authRouter'
import communityRouter from './community/communityRouter'
import shopifyRouter from './shopify/shopifyRouter'
import productsRouter from './products/productsRouter'
import ordersRouter from './orders/ordersRouter'
import adminOrdersRouter from './admin/adminOrdersRouter'
import { handleYocoWebhook } from './orders/yocoWebhookHandler'
import { handleTcgWebhook } from './orders/tcgWebhookHandler'
import bodyParser from 'body-parser'
import cors from 'cors'

const app = express()
const workspaceRoot = path.resolve(__dirname, '..', '..')
const publicCandidates = [
  path.resolve(workspaceRoot, 'app', 'public'),
  path.resolve(process.cwd(), '..', 'app', 'public'),
  path.resolve(process.cwd(), 'app', 'public'),
]
const publicDir = publicCandidates.find((dir) => fs.existsSync(dir))
const homepageImgsDir = publicDir ? path.resolve(publicDir, 'homepageimgs') : ''

app.use(cors())
app.post(
  '/webhooks/yoco',
  express.raw({ type: ['application/json', 'text/plain', '*/*'], limit: '2mb' }),
  (req, res) => handleYocoWebhook(req, res)
)

const yocoReturnHtml = (title: string, message: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
.card{max-width:360px}h1{font-size:1.25rem}p{opacity:.85;line-height:1.5}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p><p>You can close this screen and return to the WonderPort app.</p></div></body></html>`

app.get('/payment/yoco/success', (_req, res) => {
  res.type('html').send(
    yocoReturnHtml(
      'Payment received',
      'Thank you. We are confirming your payment — your order will update shortly in the app.',
    ),
  )
})
app.get('/payment/yoco/failed', (_req, res) => {
  res.type('html').send(yocoReturnHtml('Payment not completed', 'The card payment did not go through. You can try again from the app.'))
})
app.get('/payment/yoco/cancelled', (_req, res) => {
  res.type('html').send(yocoReturnHtml('Payment cancelled', 'You cancelled checkout. Your order is still pending payment.'))
})
app.post('/webhooks/shiplogic', express.json({ limit: '512kb' }), (req, res) => handleTcgWebhook(req, res))
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }))
app.use(bodyParser.json({ limit: '50mb' }))
if (publicDir) {
  app.use('/homepageimgs', express.static(homepageImgsDir))
  app.use(express.static(publicDir))
  console.log(`[static] serving public assets from ${publicDir}`)
  console.log(`[static] serving homepage images from ${homepageImgsDir}`)
} else {
  console.warn('[static] app/public not found; coin SVG assets will 404')
}

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.use('/chat', chatRouter)
app.use('/images', imagesRouter)
app.use('/auth', authRouter)
app.use('/community', communityRouter)
app.use('/shopify', shopifyRouter)
app.use('/orders', ordersRouter)
app.use('/admin', adminOrdersRouter)
app.use('/', productsRouter)

app.listen(3050, () => {
  console.log('Server started on port 3050')
})
