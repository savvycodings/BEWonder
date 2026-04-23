import express from 'express'
import { Response } from 'express'
import { runQuery } from '../db/client'
import { getAuthUserFromRequest } from '../auth/session'
import { v2 as cloudinary } from 'cloudinary'
import crypto from 'crypto'

type Client = {
  userId: string
  res: Response
}

const clients: Client[] = []
const router = express.Router()

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

function sendEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

const ALLOWED_CHAT_AVATAR_FRAMES = new Set(['none', 'neon', 'gold', 'rainbow', 'prism'])

function avatarFrameIdFromDb(raw: string | null | undefined): string {
  const v = String(raw ?? 'none').trim()
  return ALLOWED_CHAT_AVATAR_FRAMES.has(v) ? v : 'none'
}

async function fetchRecentMessages(limit: number = 100) {
  try {
    const result = await runQuery<{
      id: string
      body: string | null
      image_url: string | null
      created_at: string
      user_id: string
      name: string | null
      image: string | null
      avatar_frame: string | null
    }>(
      `
        SELECT
          m.id,
          m.body,
          m.image_url,
          m.created_at,
          u.id as user_id,
          u.name,
          u.image,
          u.avatar_frame
        FROM community_messages m
        JOIN users u ON u.id = m.user_id
        ORDER BY m.created_at ASC
        LIMIT $1
      `,
      [limit]
    )

    return result.rows.map((row) => ({
      id: row.id,
      body: row.body || '',
      imageUrl: row.image_url,
      createdAt: row.created_at,
      user: {
        id: row.user_id,
        fullName: row.name || '',
        profilePicture: row.image,
        avatarFrameId: avatarFrameIdFromDb(row.avatar_frame),
      },
    }))
  } catch (error: any) {
    // If the DB doesn't have community tables yet, keep the server alive.
    if (error?.code === '42P01') {
      return []
    }
    throw error
  }
}

router.get('/messages', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const messages = await fetchRecentMessages(200)
  return res.status(200).json({ messages })
})

router.post('/messages', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const body = String(req.body?.body || '').trim()
  const imageBase64 = String(req.body?.imageBase64 || '').trim()
  const mimeType = String(req.body?.mimeType || 'image/jpeg').trim()
  let imageUrl: string | null = null

  if (!body && !imageBase64) {
    return res.status(400).json({ error: 'Message body or image is required' })
  }

  if (imageBase64) {
    const uploadResult = await cloudinary.uploader.upload(
      `data:${mimeType};base64,${imageBase64}`,
      {
        folder: 'wonderport/community',
        public_id: `community-${auth.userId}-${Date.now()}`,
        resource_type: 'image',
      }
    )
    imageUrl = uploadResult.secure_url
  }

  let result
  try {
    const messageId = crypto.randomUUID()
    result = await runQuery<{
      id: string
      body: string | null
      image_url: string | null
      created_at: string
    }>(
      `
        INSERT INTO community_messages (id, user_id, body, image_url, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING id, body, image_url, created_at
      `,
      [messageId, auth.userId, body || null, imageUrl]
    )
  } catch (error: any) {
    if (error?.code === '42P01') {
      return res.status(501).json({
        error: 'Community messaging is not enabled on this database yet.',
      })
    }
    throw error
  }

  const inserted = result.rows[0]
  const message = {
    id: inserted.id,
    body: inserted.body || '',
    imageUrl: inserted.image_url,
    createdAt: inserted.created_at,
    user: {
      id: auth.user.id,
      fullName: auth.user.fullName,
      profilePicture: auth.user.profilePicture ?? null,
      avatarFrameId: avatarFrameIdFromDb(auth.user.avatarFrameId),
    },
  }

  clients.forEach((client) => sendEvent(client.res, 'message', message))
  return res.status(201).json({ message })
})

router.patch('/messages/:messageId', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const messageId = String(req.params.messageId || '').trim()
  const body = String(req.body?.body || '').trim()

  if (!messageId) {
    return res.status(400).json({ error: 'Message id is required' })
  }
  if (!body) {
    return res.status(400).json({ error: 'Message body is required' })
  }

  let result
  try {
    result = await runQuery<{
      id: string
      body: string | null
      image_url: string | null
      created_at: string
    }>(
      `
        UPDATE community_messages
        SET body = $1, updated_at = NOW()
        WHERE id = $2 AND user_id = $3
        RETURNING id, body, image_url, created_at
      `,
      [body, messageId, auth.userId]
    )
  } catch (error: any) {
    if (error?.code === '42P01') {
      return res.status(501).json({
        error: 'Community messaging is not enabled on this database yet.',
      })
    }
    throw error
  }

  const updated = result.rows[0]
  if (!updated) {
    return res.status(404).json({ error: 'Message not found or not owned by user' })
  }

  const message = {
    id: updated.id,
    body: updated.body || '',
    imageUrl: updated.image_url,
    createdAt: updated.created_at,
    user: {
      id: auth.user.id,
      fullName: auth.user.fullName,
      profilePicture: auth.user.profilePicture ?? null,
      avatarFrameId: avatarFrameIdFromDb(auth.user.avatarFrameId),
    },
  }

  clients.forEach((client) => sendEvent(client.res, 'message_updated', message))
  return res.status(200).json({ message })
})

router.delete('/messages/:messageId', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const messageId = String(req.params.messageId || '').trim()
  if (!messageId) {
    return res.status(400).json({ error: 'Message id is required' })
  }

  let result
  try {
    result = await runQuery<{ id: string }>(
      `
        DELETE FROM community_messages
        WHERE id = $1 AND user_id = $2
        RETURNING id
      `,
      [messageId, auth.userId]
    )
  } catch (error: any) {
    if (error?.code === '42P01') {
      return res.status(501).json({
        error: 'Community messaging is not enabled on this database yet.',
      })
    }
    throw error
  }

  const deleted = result.rows[0]
  if (!deleted) {
    return res.status(404).json({ error: 'Message not found or not owned by user' })
  }

  clients.forEach((client) => sendEvent(client.res, 'message_deleted', { id: deleted.id }))
  return res.status(200).json({ ok: true })
})

router.post('/messages/:messageId/report', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const messageId = String(req.params.messageId || '').trim()
  const reason = String(req.body?.reason || '').trim()
  if (!messageId) {
    return res.status(400).json({ error: 'Message id is required' })
  }

  try {
    const msg = await runQuery<{ id: string; user_id: string }>(
      `
        SELECT id, user_id
        FROM community_messages
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [messageId]
    )
    const row = msg.rows[0]
    if (!row) {
      return res.status(404).json({ error: 'Message not found' })
    }

    const existing = await runQuery<{ id: string }>(
      `
        SELECT id
        FROM community_message_reports
        WHERE message_id = $1::uuid
          AND reported_by_user_id = $2
          AND status = 'open'
        LIMIT 1
      `,
      [messageId, auth.userId]
    )
    if (existing.rows[0]) {
      return res.status(200).json({ ok: true, duplicate: true })
    }

    await runQuery(
      `
        INSERT INTO community_message_reports (
          id,
          message_id,
          reported_by_user_id,
          reported_user_id,
          reason,
          status,
          created_at
        )
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'open', NOW())
      `,
      [crypto.randomUUID(), messageId, auth.userId, row.user_id, reason || null]
    )

    return res.status(201).json({ ok: true })
  } catch (error: any) {
    if (error?.code === '42P01') {
      return res.status(501).json({
        error: 'Community reporting is not enabled on this database yet.',
      })
    }
    throw error
  }
})

router.get('/stream', async (req, res) => {
  const auth = await getAuthUserFromRequest(req)
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const client: Client = { userId: auth.userId, res }
  clients.push(client)

  try {
    const history = await fetchRecentMessages(200)
    sendEvent(res, 'history', history)
  } catch (error: any) {
    if (error?.code === '42P01') {
      sendEvent(res, 'history', [])
    } else {
      throw error
    }
  }

  const heartbeat = setInterval(() => {
    sendEvent(res, 'heartbeat', { ok: true })
  }, 15000)

  req.on('close', () => {
    clearInterval(heartbeat)
    const idx = clients.findIndex((c) => c.res === res)
    if (idx > -1) {
      clients.splice(idx, 1)
    }
  })
})

export default router
