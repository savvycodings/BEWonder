import express from 'express'
import { getProductByHandle, listProducts } from './storefront'

const router = express.Router()

router.get(
  '/products',
  async (req, res, next) => {
    try {
      const first = Number(req.query.first || 20)
      const query = String(req.query.query || '').trim()
      const products = await listProducts({ first, query: query || undefined })
      res.status(200).json({ products })
    } catch (err) {
      next(err)
    }
  }
)

router.get(
  '/products/:handle',
  async (req, res, next) => {
    try {
      const handle = String(req.params.handle || '').trim()
      const product = await getProductByHandle(handle)
      if (!product) {
        res.status(404).json({ error: 'Product not found' })
        return
      }
      res.status(200).json({ product })
    } catch (err) {
      next(err)
    }
  }
)

export default router

