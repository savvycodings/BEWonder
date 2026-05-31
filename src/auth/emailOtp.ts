import crypto from 'crypto'
import { runQuery } from '../db/client'
import { logAuthEmailEvent } from './authEmailLog'
import { sendOtpEmail } from './resendMail'

export const EMAIL_OTP_TTL_MS = 15 * 60 * 1000
const OTP_LENGTH = 6

export type EmailOtpPurpose = 'signin' | 'signup'

function purposeKey(purpose: EmailOtpPurpose, email: string): string {
  return `${purpose}:${email.trim().toLowerCase()}`
}

function signupVerifiedKey(email: string): string {
  return `signup-verified:${email.trim().toLowerCase()}`
}

function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(OTP_LENGTH, '0')
}

function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex')
}

export async function requestEmailOtp(
  email: string,
  purpose: EmailOtpPurpose,
): Promise<{ ok: true; devOtpLogged?: boolean; emailSent?: boolean; emailWarning?: string }> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return { ok: true }

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
  const hasAccount = Boolean(userResult.rows[0]?.id)

  if (purpose === 'signin' && !hasAccount) {
    logAuthEmailEvent('otp_request_skipped', { email: normalized, purpose, reason: 'no_account' })
    return { ok: true }
  }
  if (purpose === 'signup' && hasAccount) {
    logAuthEmailEvent('otp_request_skipped', { email: normalized, purpose, reason: 'already_registered' })
    return { ok: true }
  }

  const otp = generateOtp()
  logAuthEmailEvent('otp_generated', { email: normalized, purpose, expiresMinutes: 15 }, otp)
  const otpHash = hashOtp(otp)
  const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS)
  const id = crypto.randomUUID()
  const identifier = purposeKey(purpose, normalized)

  try {
    await runQuery(
      `
        DELETE FROM verifications
        WHERE identifier = $1
      `,
      [identifier],
    )
    await runQuery(
      `
        INSERT INTO verifications (id, identifier, value, expires_at, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `,
      [id, identifier, otpHash, expiresAt],
    )
  } catch (e: any) {
    if (e?.code === '42P01') {
      throw Object.assign(new Error('Email verification is not available on this database yet.'), {
        status: 503,
      })
    }
    throw e
  }

  const subject =
    purpose === 'signin'
      ? 'Your Wonderport sign-in code'
      : 'Your Wonderport sign-up code'
  const title =
    purpose === 'signin'
      ? 'Use this code to sign in to Wonderport.'
      : 'Use this code to verify your email for Wonderport sign-up.'
  const footer = 'This code expires in 15 minutes. If you did not request it, ignore this email.'

  const mail = await sendOtpEmail({
    to: normalized,
    subject,
    title,
    otp,
    footer,
  })

  logAuthEmailEvent('otp_email_dispatched', {
    email: normalized,
    purpose,
    sent: mail.sent,
    devLogged: Boolean(mail.devLogged),
  })

  const emailWarning =
    !mail.sent && mail.resendError
      ? mail.resendError
      : !mail.sent && mail.devLogged
        ? 'Email was not sent; use the code from the API server terminal.'
        : undefined

  return {
    ok: true,
    devOtpLogged: mail.devLogged,
    emailSent: mail.sent,
    emailWarning,
  }
}

export async function verifyEmailOtp(
  email: string,
  otp: string,
  purpose: EmailOtpPurpose,
): Promise<boolean> {
  const normalized = email.trim().toLowerCase()
  const trimmedOtp = String(otp || '').trim()
  if (!normalized || trimmedOtp.length !== OTP_LENGTH) return false

  const otpHash = hashOtp(trimmedOtp)
  const identifier = purposeKey(purpose, normalized)

  const r = await runQuery<{ id: string }>(
    `
      SELECT id
      FROM verifications
      WHERE identifier = $1
        AND value = $2
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [identifier, otpHash],
  )
  const row = r.rows[0]
  if (!row) return false

  await runQuery(`DELETE FROM verifications WHERE id = $1`, [row.id])

  if (purpose === 'signup') {
    const verifiedId = crypto.randomUUID()
    await runQuery(
      `
        DELETE FROM verifications WHERE identifier = $1
      `,
      [signupVerifiedKey(normalized)],
    )
    await runQuery(
      `
        INSERT INTO verifications (id, identifier, value, expires_at, created_at)
        VALUES ($1, $2, 'ok', $3, NOW())
      `,
      [verifiedId, signupVerifiedKey(normalized), new Date(Date.now() + EMAIL_OTP_TTL_MS)],
    )
  }

  return true
}

export async function consumeSignupEmailVerification(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase()
  const identifier = signupVerifiedKey(normalized)
  const r = await runQuery<{ id: string }>(
    `
      SELECT id
      FROM verifications
      WHERE identifier = $1
        AND value = 'ok'
        AND expires_at > NOW()
      LIMIT 1
    `,
    [identifier],
  )
  const row = r.rows[0]
  if (!row) return false
  await runQuery(`DELETE FROM verifications WHERE id = $1`, [row.id])
  return true
}
