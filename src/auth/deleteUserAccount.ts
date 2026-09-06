import type { PoolClient } from 'pg'
import { verifyPassword } from './passwordCrypto'
import { getPasswordHashForUser } from './passwordReset'

function deletedEmailForUserId(userId: string): string {
  const slug = String(userId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 120)
  return `deleted-${slug || 'user'}@deleted.wonderport.local`
}

/** Best-effort delete on tables that may not exist in every environment. */
async function safeDelete(client: PoolClient, sql: string, params: unknown[]) {
  try {
    await client.query(sql, params)
  } catch (error: any) {
    if (error?.code === '42P01') return
    throw error
  }
}

/**
 * Permanently closes a customer account: removes auth/sessions and PII,
 * retains order rows for fulfilment/audit (user_id unchanged on orders).
 */
export async function deleteUserAccount(
  client: PoolClient,
  userId: string,
  password: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const trimmedPassword = String(password || '')
  if (!trimmedPassword) {
    return { ok: false, status: 400, error: 'Password is required to delete your account.' }
  }

  const storedHash = await getPasswordHashForUser(client, userId)
  if (!storedHash) {
    return {
      ok: false,
      status: 400,
      error: 'This account does not use email/password sign-in.',
    }
  }
  if (!verifyPassword(trimmedPassword, storedHash)) {
    return { ok: false, status: 401, error: 'Password is incorrect.' }
  }

  const tombstoneEmail = deletedEmailForUserId(userId)

  await client.query(
    `
      UPDATE users
      SET
        email = $2,
        name = 'Deleted account',
        image = NULL,
        phone = NULL,
        shipping_name = NULL,
        shipping_address1 = NULL,
        shipping_address2 = NULL,
        shipping_postal_code = NULL,
        shipping_city = NULL,
        shipping_region = NULL,
        shipping_country = NULL,
        pudo_locker_name = NULL,
        pudo_locker_address = NULL,
        eft_bank_account_name = NULL,
        eft_bank_name = NULL,
        eft_bank_account_number = NULL,
        eft_bank_branch = NULL,
        profile_banner_url = NULL,
        profile_badge_slots = '[]'::jsonb,
        wonder_coins = 0,
        wonder_gems = 0,
        avatar_frame = 'none',
        updated_at = NOW()
      WHERE id::text = $1
    `,
    [userId, tombstoneEmail],
  )

  await safeDelete(client, `DELETE FROM sessions WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM user_sessions WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM accounts WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM user_cart_items WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM user_saved_products WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM user_daily_rewards WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM user_wonder_store_purchases WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM user_redeem_codes WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM user_wonder_jump_progress WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM password_reset_otps WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM notification_outbox WHERE user_id = $1`, [userId])
  await safeDelete(client, `DELETE FROM community_messages WHERE user_id = $1`, [userId])
  await safeDelete(
    client,
    `DELETE FROM community_message_reports WHERE reported_by_user_id = $1 OR reported_user_id = $1`,
    [userId],
  )

  return { ok: true }
}
