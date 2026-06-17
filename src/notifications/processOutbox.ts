import { runQuery } from '../db/client'
import { isResendConfigured, sendAuthEmail } from '../auth/resendMail'
import {
  buildRestockEmailHtml,
  buildRestockEmailText,
  restockEmailSubject,
} from './restockEmail'

const BATCH_SIZE = 50

export type ProcessOutboxResult = {
  sent: number
  failed: number
  skipped: number
}

type PendingRow = {
  id: string
  user_id: string
  product_id: number
  payload: {
    title?: string
    handle?: string
    thumbnailUrl?: string | null
    productUrl?: string
    unsubscribeUrl?: string
  }
  email: string
  name: string | null
}

export async function processOutbox(): Promise<ProcessOutboxResult> {
  const result: ProcessOutboxResult = { sent: 0, failed: 0, skipped: 0 }

  if (!isResendConfigured()) {
    const pending = await runQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM notification_outbox WHERE status = 'pending' AND channel = 'email'`,
    )
    const n = parseInt(pending.rows[0]?.c || '0', 10)
    result.skipped = Number.isFinite(n) ? n : 0
    return result
  }

  const batch = await runQuery<PendingRow>(
    `
      SELECT
        o.id,
        o.user_id,
        o.product_id,
        o.payload,
        u.email,
        u.name
      FROM notification_outbox o
      INNER JOIN users u ON u.id::text = o.user_id
      WHERE o.status = 'pending'
        AND o.channel = 'email'
      ORDER BY o.created_at ASC
      LIMIT $1
    `,
    [BATCH_SIZE],
  )

  for (const row of batch.rows) {
    const title = String(row.payload?.title || 'Your item').trim() || 'Your item'
    const productUrl = String(row.payload?.productUrl || '').trim()
    const unsubscribeUrl = String(row.payload?.unsubscribeUrl || '').trim()
    const userName = String(row.name || '').trim() || 'there'

    const mail = await sendAuthEmail({
      to: row.email,
      subject: restockEmailSubject(title),
      text: buildRestockEmailText({
        userName,
        productTitle: title,
        productUrl: productUrl || 'https://wonderporthobbies.com',
        unsubscribeUrl: unsubscribeUrl || 'https://wonderporthobbies.com',
      }),
      html: buildRestockEmailHtml({
        userName,
        productTitle: title,
        productHandle: String(row.payload?.handle || ''),
        productId: row.product_id,
        thumbnailUrl: row.payload?.thumbnailUrl ?? null,
        productUrl: productUrl || 'https://wonderporthobbies.com',
        unsubscribeUrl: unsubscribeUrl || 'https://wonderporthobbies.com',
      }),
    })

    if (mail.sent) {
      await runQuery(
        `
          UPDATE notification_outbox
          SET status = 'sent', sent_at = NOW()
          WHERE id = $1::uuid
        `,
        [row.id],
      )
      await runQuery(
        `
          UPDATE user_saved_products
          SET last_notified_at = NOW()
          WHERE user_id = $1 AND product_id = $2
        `,
        [row.user_id, row.product_id],
      )
      result.sent += 1
    } else {
      await runQuery(
        `
          UPDATE notification_outbox
          SET status = 'failed'
          WHERE id = $1::uuid
        `,
        [row.id],
      )
      result.failed += 1
    }
  }

  return result
}

export async function getNotificationOutboxSummary() {
  const counts = await runQuery<{ status: string; c: string }>(
    `
      SELECT status, COUNT(*)::text AS c
      FROM notification_outbox
      WHERE channel = 'email'
      GROUP BY status
    `,
  )
  const byStatus: Record<string, number> = {}
  for (const row of counts.rows) {
    byStatus[row.status] = parseInt(row.c, 10) || 0
  }

  const recent = await runQuery<{
    id: string
    user_id: string
    product_id: number
    status: string
    created_at: string
    sent_at: string | null
    payload: { title?: string }
    email: string | null
  }>(
    `
      SELECT
        o.id,
        o.user_id,
        o.product_id,
        o.status,
        o.created_at,
        o.sent_at,
        o.payload,
        u.email
      FROM notification_outbox o
      LEFT JOIN users u ON u.id::text = o.user_id
      WHERE o.channel = 'email'
      ORDER BY o.created_at DESC
      LIMIT 20
    `,
  )

  return {
    pendingCount: byStatus.pending || 0,
    sentCount: byStatus.sent || 0,
    failedCount: byStatus.failed || 0,
    recent: recent.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      productId: r.product_id,
      status: r.status,
      createdAt: r.created_at,
      sentAt: r.sent_at,
      productTitle: r.payload?.title || null,
      userEmail: r.email,
    })),
  }
}
