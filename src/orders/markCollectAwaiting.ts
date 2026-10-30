import type { PoolClient } from 'pg'
import { pool } from '../db/client'

/** When a Collect order becomes paid, mark it awaiting in-store pickup. */
export async function markCollectAwaitingForPaidOrder(
  orderId: string,
  client?: PoolClient,
): Promise<void> {
  const q = client ?? pool
  await q.query(
    `
      UPDATE orders
      SET
        collect_status = 'awaiting_collection',
        updated_at = NOW()
      WHERE id = $1::uuid
        AND status = 'paid'
        AND pudo_locker_tier = 'collect'
        AND (collect_status IS NULL OR collect_status = '')
    `,
    [orderId],
  )
}
