/** Parse `users.wonder_coins` / `users.wonder_gems` from Postgres (may arrive as string). */
export function coerceWonderWalletInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value))
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number.parseInt(value, 10)
    if (Number.isFinite(n)) return Math.max(0, n)
  }
  return 0
}
