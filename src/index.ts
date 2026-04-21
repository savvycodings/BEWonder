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
import { handlePeachWebhook } from './orders/peachWebhookHandler'
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
  '/webhooks/peach',
  express.raw({ type: ['application/json', 'text/plain', '*/*'], limit: '2mb' }),
  (req, res) => handlePeachWebhook(req, res)
)
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
