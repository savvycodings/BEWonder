/** Console logging for auth email / OTP flows (always logs events; OTP when enabled). */

export function shouldLogOtpPlaintext(): boolean {
  return (
    process.env.AUTH_EMAIL_LOG_OTP === 'true' ||
    process.env.PASSWORD_RESET_LOG_OTP === 'true' ||
    process.env.NODE_ENV !== 'production'
  )
}

export function logAuthEmailEvent(
  event: string,
  meta: Record<string, string | number | boolean | undefined>,
  otp?: string,
): void {
  const payload: Record<string, unknown> = { event, ...meta }
  console.log('[auth-email]', JSON.stringify(payload))
  if (otp && shouldLogOtpPlaintext()) {
    const email = typeof meta.email === 'string' ? meta.email : '(unknown)'
    console.log(`[auth-email] OTP plaintext → ${email}: ${otp}`)
  }
}
