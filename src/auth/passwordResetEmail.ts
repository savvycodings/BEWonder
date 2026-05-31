import { sendOtpEmail, type SendAuthEmailResult } from './resendMail'

export type SendPasswordResetOtpResult = SendAuthEmailResult

export async function sendPasswordResetOtpEmail(
  email: string,
  otp: string,
): Promise<SendPasswordResetOtpResult> {
  return sendOtpEmail({
    to: email,
    subject: 'Your Wonderport password reset code',
    title: 'Use this code to reset your Wonderport password.',
    otp,
    footer:
      'This code expires in 15 minutes. If you did not request a password reset, ignore this email.',
  })
}
