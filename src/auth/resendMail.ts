/**
 * Resend email delivery for auth flows (password reset, sign-in/sign-up codes).
 * Requires RESEND_API_KEY and AUTH_EMAIL_FROM (or PASSWORD_RESET_FROM_EMAIL).
 */

import { logAuthEmailEvent, shouldLogOtpPlaintext } from './authEmailLog'

export type SendAuthEmailResult = {
  sent: boolean
  /** Dev-only: OTP logged to server console when email was not sent. */
  devLogged?: boolean
  /** Set when Resend API rejected the send (e.g. testing sender → wrong recipient). */
  resendError?: string
}

function authFromAddress(): string | null {
  return (
    process.env.AUTH_EMAIL_FROM?.trim() ||
    process.env.PASSWORD_RESET_FROM_EMAIL?.trim() ||
    null
  )
}

export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && authFromAddress())
}

export async function sendAuthEmail(params: {
  to: string
  subject: string
  text: string
  html?: string
}): Promise<SendAuthEmailResult> {
  const resendKey = process.env.RESEND_API_KEY?.trim()
  const from = authFromAddress()

  logAuthEmailEvent('send_attempt', {
    to: params.to,
    subject: params.subject,
    resendConfigured: Boolean(resendKey && from),
  })

  if (resendKey && from) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [params.to],
          subject: params.subject,
          text: params.text,
          ...(params.html ? { html: params.html } : {}),
        }),
      })
      if (res.ok) {
        logAuthEmailEvent('send_ok', { to: params.to, subject: params.subject, channel: 'resend' })
        return { sent: true }
      }
      const errBody = await res.text()
      let resendError: string | undefined
      try {
        const parsed = JSON.parse(errBody) as { message?: string }
        resendError = parsed.message
      } catch {
        resendError = errBody.slice(0, 300)
      }
      logAuthEmailEvent('send_failed', {
        to: params.to,
        subject: params.subject,
        channel: 'resend',
        status: res.status,
        detail: errBody.slice(0, 200),
      })
      console.error('[resend] send failed', res.status, errBody)
      if (res.status === 403 && errBody.includes('only send testing emails')) {
        console.warn(
          '[resend] Testing sender (onboarding@resend.dev) only delivers to the email on your Resend account. ' +
            'Sign up with that address, or verify a domain at https://resend.com/domains and set AUTH_EMAIL_FROM.',
        )
      }
      if (shouldLogOtpPlaintext()) {
        logAuthEmailEvent('send_fallback_console', { to: params.to, subject: params.subject })
        console.log(`[auth-email] body for ${params.to}:\n${params.text}`)
        return { sent: false, devLogged: true, resendError }
      }
      return { sent: false, resendError }
    } catch (e) {
      logAuthEmailEvent('send_error', { to: params.to, subject: params.subject, channel: 'resend' })
      console.error('[resend] send error', e)
    }
  }

  if (shouldLogOtpPlaintext()) {
    logAuthEmailEvent('send_fallback_console', { to: params.to, subject: params.subject })
    console.log(`[auth-email] body for ${params.to}:\n${params.text}`)
    return {
      sent: false,
      devLogged: true,
      resendError: 'Resend is not configured (missing RESEND_API_KEY or AUTH_EMAIL_FROM).',
    }
  }

  logAuthEmailEvent('send_skipped', { to: params.to, subject: params.subject, reason: 'not_configured' })
  return { sent: false }
}

function otpEmailHtml(title: string, otp: string, footer: string): string {
  return `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <p style="font-size:18px;font-weight:600;color:#111;margin:0 0 16px;">${title}</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#E32828;margin:0 0 16px;">${otp}</p>
      <p style="font-size:14px;color:#444;line-height:1.5;margin:0;">${footer}</p>
    </div>
  `.trim()
}

export async function sendOtpEmail(params: {
  to: string
  subject: string
  title: string
  otp: string
  footer: string
}): Promise<SendAuthEmailResult> {
  const text = `${params.title}\n\nYour code: ${params.otp}\n\n${params.footer}`
  return sendAuthEmail({
    to: params.to,
    subject: params.subject,
    text,
    html: otpEmailHtml(params.title, params.otp, params.footer),
  })
}
