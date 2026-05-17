/**
 * Password-reset email delivery (framework).
 *
 * To go live, set env vars and implement the provider block below, e.g.:
 * - RESEND_API_KEY + PASSWORD_RESET_FROM_EMAIL (Resend)
 * - SENDGRID_API_KEY + PASSWORD_RESET_FROM_EMAIL (SendGrid)
 * - AWS SES credentials
 *
 * Until then, OTP is logged in development when PASSWORD_RESET_LOG_OTP=true (default in non-production).
 */

export type SendPasswordResetOtpResult = {
  sent: boolean
  /** Dev-only: set when OTP was logged to the server console instead of emailed. */
  devLogged?: boolean
}

export async function sendPasswordResetOtpEmail(
  email: string,
  otp: string,
): Promise<SendPasswordResetOtpResult> {
  const from = process.env.PASSWORD_RESET_FROM_EMAIL?.trim()
  const resendKey = process.env.RESEND_API_KEY?.trim()

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
          to: [email],
          subject: 'Your Wonderport password reset code',
          text: `Your verification code is ${otp}. It expires in 15 minutes. If you did not request this, ignore this email.`,
        }),
      })
      if (res.ok) return { sent: true }
      console.error('[password-reset] Resend failed', res.status, await res.text())
    } catch (e) {
      console.error('[password-reset] Resend error', e)
    }
  }

  const logInDev =
    process.env.NODE_ENV !== 'production' ||
    process.env.PASSWORD_RESET_LOG_OTP === 'true'
  if (logInDev) {
    console.log(`[password-reset] OTP for ${email}: ${otp}`)
    return { sent: true, devLogged: true }
  }

  return { sent: false }
}
