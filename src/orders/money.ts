/** DB / API money string (e.g. "19.99") to integer cents. */
export function moneyStringToCents(amount: unknown, currencyFallback = 'USD'): { cents: number; currency: string } {
  const n = parseFloat(String(amount ?? ''))
  const cents = Number.isFinite(n) ? Math.round(n * 100) : 0
  return { cents, currency: currencyFallback }
}

export function centsToDecimalString(cents: number): string {
  return (cents / 100).toFixed(2)
}
