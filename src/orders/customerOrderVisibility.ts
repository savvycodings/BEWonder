/**
 * Orders visible in Profile → My orders (customer completed checkout).
 * - Card: paid (or refunded after purchase)
 * - EFT: proof uploaded (user finished the in-app flow)
 * - Paid Collect still awaiting pickup lives in "In-store collection", not My orders
 *
 * Use COALESCE on pudo_locker_tier so older paid orders with a null tier stay visible.
 */
export function customerOrderHistoryWhereSql(alias = 'o'): string {
  return `(
    (
      ${alias}.status IN ('paid', 'refunded')
      OR (
        ${alias}.payment_method = 'eft'
        AND ${alias}.eft_proof_image_url IS NOT NULL
        AND TRIM(${alias}.eft_proof_image_url) <> ''
      )
    )
    AND NOT (
      COALESCE(${alias}.pudo_locker_tier, '') = 'collect'
      AND COALESCE(NULLIF(TRIM(${alias}.collect_status), ''), 'awaiting_collection') = 'awaiting_collection'
    )
  )`
}

/** Paid Collect orders waiting for in-store handover (buyer profile section). */
export function customerAwaitingCollectionWhereSql(alias = 'o'): string {
  return `(
    ${alias}.status = 'paid'
    AND COALESCE(${alias}.pudo_locker_tier, '') = 'collect'
    AND COALESCE(NULLIF(TRIM(${alias}.collect_status), ''), 'awaiting_collection') = 'awaiting_collection'
  )`
}

export function isCustomerVisibleOrder(order: {
  status: string
  payment_method: string
  eft_proof_image_url: string | null
}): boolean {
  if (order.status === 'paid' || order.status === 'refunded') return true
  if (
    order.payment_method === 'eft' &&
    Boolean(String(order.eft_proof_image_url || '').trim())
  ) {
    return true
  }
  return false
}

export function canCustomerAbandonOrder(order: {
  status: string
  payment_method: string
  eft_proof_image_url: string | null
}): boolean {
  if (order.status === 'cancelled') return false
  if (order.status === 'paid' || order.status === 'refunded') return false
  const hasProof =
    order.payment_method === 'eft' &&
    Boolean(String(order.eft_proof_image_url || '').trim())
  if (hasProof) return false
  return order.status === 'pending_payment' || order.status === 'awaiting_proof'
}
