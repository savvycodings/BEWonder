import crypto from 'crypto'
import type { Pool, PoolClient } from 'pg'
import { runQuery } from '../db/client'
import { hashPassword, verifyPassword } from './passwordCrypto'
import { logAuthEmailEvent } from './authEmailLog'
import { sendPasswordResetOtpEmail } from './passwordResetEmail'

export const PASSWORD_RESET_OTP_TTL_MS = 15 * 60 * 1000
const OTP_LENGTH = 6

export function validateNewPasswordPair(newPassword: string, confirmNewPassword: string): string | null {
  if (!newPassword || !confirmNewPassword) {
    return 'New password and confirmation are required'
  }
  if (newPassword !== confirmNewPassword) {
    return 'New passwords do not match'
  }
  if (newPassword.length < 8) {
    return 'Password must be at least 8 characters'
  }
  return null
}

export async function getPasswordHashForUser(
  executor: Pool | PoolClient,
  userId: string,
): Promise<string | null> {
  const r = await executor.query<{ access_token: string | null }>(
    `
      SELECT access_token
      FROM accounts
      WHERE user_id = $1 AND provider_id = 'password'
      LIMIT 1
    `,
    [userId],
  )
  return r.rows[0]?.access_token ?? null
}

export async function updatePasswordHashForUser(
  executor: Pool | PoolClient,
  userId: string,
  passwordHash: string,
): Promise<boolean> {
  const r = await executor.query(
    `
      UPDATE accounts
      SET access_token = $2, updated_at = NOW()
      WHERE user_id = $1 AND provider_id = 'password'
    `,
    [userId, passwordHash],
  )
  return (r.rowCount ?? 0) > 0
}

function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(OTP_LENGTH, '0')
}

function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex')
}

export async function requestPasswordResetOtp(email: string): Promise<{
  ok: true
  devOtpLogged?: boolean
}> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) {
    return { ok: true }
  }

  const userResult = await runQuery<{ id: string }>(
    `
      SELECT u.id
      FROM users u
      INNER JOIN accounts a ON a.user_id = u.id::text AND a.provider_id = 'password'
      WHERE LOWER(u.email) = $1
      LIMIT 1
    `,
    [normalized],
  )
  const userId = userResult.rows[0]?.id
  if (!userId) {
    return { ok: true }
  }

  const otp = generateOtp()
  logAuthEmailEvent('password_reset_otp_generated', { email: normalized, expiresMinutes: 15 }, otp)
  const otpHash = hashOtp(otp)
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_OTP_TTL_MS)

  try {
    await runQuery(
      `
        UPDATE password_reset_otps
        SET used_at = NOW()
        WHERE user_id = $1 AND used_at IS NULL
      `,
      [String(userId)],
    )

    await runQuery(
      `
        INSERT INTO password_reset_otps (user_id, email, otp_hash, expires_at)
        VALUES ($1, $2, $3, $4)
      `,
      [String(userId), normalized, otpHash, expiresAt],
    )
  } catch (e: any) {
    if (e?.code === '42P01') {
      throw Object.assign(new Error('Password reset is not available on this database yet.'), {
        status: 503,
      })
    }
    throw e
  }

  const mail = await sendPasswordResetOtpEmail(normalized, otp)
  logAuthEmailEvent('password_reset_email_dispatched', {
    email: normalized,
    sent: mail.sent,
    devLogged: Boolean(mail.devLogged),
  })
  return { ok: true, devOtpLogged: mail.devLogged }
}

export async function verifyPasswordResetOtp(email: string, otp: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase()
  const otpHash = hashOtp(String(otp || '').trim())
  if (!normalized || otp.length !== OTP_LENGTH) return false

  const r = await runQuery<{ id: string }>(
    `
      SELECT id
      FROM password_reset_otps
      WHERE email = $1
        AND otp_hash = $2
        AND used_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [normalized, otpHash],
  )
  return Boolean(r.rows[0])
}

export async function resetPasswordWithOtp(
  email: string,
  otp: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const normalized = email.trim().toLowerCase()
  const otpHash = hashOtp(String(otp || '').trim())

  const row = await runQuery<{ id: string; user_id: string }>(
    `
      SELECT id, user_id
      FROM password_reset_otps
      WHERE email = $1
        AND otp_hash = $2
        AND used_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [normalized, otpHash],
  )
  const token = row.rows[0]
  if (!token) {
    return { ok: false, status: 400, message: 'Invalid or expired verification code' }
  }

  const passwordHash = hashPassword(newPassword)
  const upd = await runQuery(
    `
      UPDATE accounts
      SET access_token = $2, updated_at = NOW()
      WHERE user_id = $1 AND provider_id = 'password'
    `,
    [token.user_id, passwordHash],
  )
  if ((upd.rowCount ?? 0) === 0) {
    return { ok: false, status: 400, message: 'No password login found for this account' }
  }

  await runQuery(
    `
      UPDATE password_reset_otps
      SET used_at = NOW()
      WHERE id = $1
    `,
    [token.id],
  )

  return { ok: true }
}

export { verifyPassword, hashPassword }
