import crypto from 'crypto'
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const ADMIN_ROLE = 'admin_orders'

export function verifyAdminPassword(password: string): boolean {
  const expected = process.env.ADMIN_ORDERS_PASSWORD
  if (!expected || !password) return false
  const a = crypto.createHash('sha256').update(password, 'utf8').digest()
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function signAdminJwt(): string | null {
  const secret = process.env.ADMIN_JWT_SECRET
  if (!secret || secret.length < 16) return null
  return jwt.sign({ role: ADMIN_ROLE }, secret, { expiresIn: '8h' })
}

export function verifyAdminJwt(token: string): boolean {
  const secret = process.env.ADMIN_JWT_SECRET
  if (!secret) return false
  try {
    const payload = jwt.verify(token, secret) as { role?: string }
    return payload?.role === ADMIN_ROLE
  } catch {
    return false
  }
}

function getBearer(req: Request): string | null {
  const authHeader = req.headers.authorization || ''
  const [type, token] = authHeader.split(' ')
  if (type !== 'Bearer' || !token) return null
  return token
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = getBearer(req)
  if (!token || !verifyAdminJwt(token)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}
