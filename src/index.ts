import 'dotenv/config'
import express from 'express'
import chatRouter from './chat/chatRouter'
import imagesRouter from './images/imagesRouter'
import authRouter from './auth/authRouter'
import communityRouter from './community/communityRouter'
import shopifyRouter from './shopify/shopifyRouter'
import productsRouter from './products/productsRouter'
import bodyParser from 'body-parser'
import cors from 'cors'

const app = express()

app.use(cors())
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }))
app.use(bodyParser.json({ limit: '50mb' }))
app.use(express.json({ limit: '50mb' }))

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.use('/chat', chatRouter)
app.use('/images', imagesRouter)
app.use('/auth', authRouter)
app.use('/community', communityRouter)
app.use('/shopify', shopifyRouter)
app.use('/', productsRouter)

app.listen(3050, () => {
  console.log('Server started on port 3050')
})
