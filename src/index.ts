import 'dotenv/config'
import express from 'express'
import chatRouter from './chat/chatRouter'
import imagesRouter from './images/imagesRouter'
import authRouter from './auth/authRouter'
import communityRouter from './community/communityRouter'
import shopifyRouter from './shopify/shopifyRouter'
import productsRouter from './products/productsRouter'
import ordersRouter from './orders/ordersRouter'
import adminOrdersRouter from './admin/adminOrdersRouter'
import { handlePeachWebhook } from './orders/peachWebhookHandler'
import bodyParser from 'body-parser'
import cors from 'cors'

const app = express()

app.use(cors())
app.post(
  '/webhooks/peach',
  express.raw({ type: ['application/json', 'text/plain', '*/*'], limit: '2mb' }),
  (req, res) => handlePeachWebhook(req, res)
)
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }))
app.use(bodyParser.json({ limit: '50mb' }))

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
