import { Response } from 'express'
import { getYocoCheckout } from './yocoClient'
import {
  applyYocoPaymentToOrder,
  runYocoPaymentSideEffects,
  type YocoOrderRow,
} from './yocoApplyPayment'
import { pool } from '../db/client'
import { yocoLog, yocoLogError } from './yocoLog'

/** Poll Yoco for checkout completion when webhooks are not configured (common in local dev). */
export async function syncYocoOrderPayment(
  auth: { userId: string },
  orderId: string,
  res: Response
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const orderRes = await client.query<YocoOrderRow & { yoco_checkout_id: string | null }>(
      `
        SELECT id, user_id, payment_method, status, total_cents, currency_code, yoco_checkout_id
        FROM orders
        WHERE id = $1 AND user_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [orderId, auth.userId]
    )
    const order = orderRes.rows[0]
    if (!order) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Order not found' })
    }
    if (order.payment_method !== 'yoco') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Order is not a Yoco card payment' })
    }
    if (order.status === 'paid') {
      await client.query('ROLLBACK')
      return res.status(200).json({ ok: true, status: 'paid', alreadyPaid: true })
    }
    if (!order.yoco_checkout_id) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'No Yoco checkout for this order — start payment first' })
    }

    yocoLog('sync lookup', { orderId, yocoCheckoutId: order.yoco_checkout_id })
    const remote = await getYocoCheckout(order.yoco_checkout_id)
    if (!remote.ok) {
      await client.query('ROLLBACK')
      yocoLogError('sync remote checkout failed', { orderId, error: remote.error })
      return res.status(503).json({ error: remote.error })
    }

    const { checkout } = remote
    const completed = checkout.status === 'completed'
    const failed = checkout.status === 'failed' || checkout.status === 'cancelled'

    if (!completed && !failed) {
      await client.query('ROLLBACK')
      return res.status(200).json({
        ok: true,
        status: order.status,
        yocoStatus: checkout.status,
        pending: true,
        processingMode: checkout.processingMode,
      })
    }

    const success = completed && Boolean(checkout.paymentId)
    const externalId = checkout.paymentId || `${checkout.id}:sync`

    try {
      const { becamePaid, status } = await applyYocoPaymentToOrder(client, {
        order,
        success,
        checkoutId: checkout.id,
        paymentId: checkout.paymentId,
        externalId,
        eventType: 'checkout_sync',
        payload: { checkout },
      })
      await client.query('COMMIT')
      void runYocoPaymentSideEffects(order.id, becamePaid, success)
      return res.status(200).json({
        ok: true,
        status,
        yocoStatus: checkout.status,
        paymentId: checkout.paymentId,
        becamePaid,
      })
    } catch (e: any) {
      if (e?.code === '23505') {
        await client.query('ROLLBACK')
        return res.status(200).json({ ok: true, status: order.status, duplicate: true })
      }
      throw e
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    console.error('[yoco sync]', error)
    return res.status(500).json({ error: 'Could not sync payment' })
  } finally {
    client.release()
  }
}
