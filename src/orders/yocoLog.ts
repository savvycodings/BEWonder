/** Server terminal logs for Yoco — never log full API keys. */
export function yocoKeyMode(secret: string): 'live' | 'test' | 'unknown' {
  if (secret.startsWith('sk_live_')) return 'live'
  if (secret.startsWith('sk_test_')) return 'test'
  return 'unknown'
}

export function yocoKeyFingerprint(secret: string): string {
  if (secret.length < 12) return '(too short)'
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`
}

export function yocoLog(event: string, data?: Record<string, unknown>) {
  const line = data ? `[yoco] ${event} ${JSON.stringify(data)}` : `[yoco] ${event}`
  console.log(line)
}

export function yocoLogError(event: string, data?: Record<string, unknown>) {
  const line = data ? `[yoco] ${event} ${JSON.stringify(data)}` : `[yoco] ${event}`
  console.error(line)
}
