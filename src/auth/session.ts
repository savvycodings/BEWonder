import crypto from 'crypto'
import { Request } from 'express'
import { runQuery } from '../db/client'

const SESSION_TTL_DAYS = 30

function getBearerToken(req: Request) {
  const authHeader = req.headers.authorization || ''
  const [type, token] = authHeader.split(' ')
  if (type !== 'Bearer' || !token) return null
  return token
}

export async function createSessionForUser(userId: string) {
  const token = crypto.randomBytes(48).toString('hex')
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS)

  await runQuery(
    `
      INSERT INTO sessions (id, user_id, expires_at, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
    `,
    [token, userId, expiresAt.toISOString()]
  )

  return token
}

export async function revokeSessionByToken(token: string) {
  await runQuery(
    `
      DELETE FROM sessions
      WHERE id = $1
    `,
    [token]
  )
}

export async function getAuthUserFromRequest(req: Request) {
  const token = getBearerToken(req)
  if (!token) return null

  const result = await runQuery<{
    user_id: string
    email: string
    created_at: string
    name: string | null
    image: string | null
    shipping_address1: string | null
    shipping_address2: string | null
  }>(
    `
      SELECT
        u.id as user_id,
        u.email,
        u.created_at,
        u.name,
        u.image,
        u.shipping_address1,
        u.shipping_address2
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
        AND s.expires_at > NOW()
      LIMIT 1
    `,
    [token]
  )

  const row = result.rows[0]
  if (!row) return null

  return {
    userId: row.user_id,
    user: {
      id: row.user_id,
      fullName: row.name || '',
      email: row.email,
      createdAt: row.created_at,
      profilePicture: row.image,
      shippingAddress: row.shipping_address1,
      // DB doesn't have a payment_method column in the Better Auth schema.
      // We leave it null for now (app UI can still function).
      paymentMethod: null,
    },
    token,
  }
}
