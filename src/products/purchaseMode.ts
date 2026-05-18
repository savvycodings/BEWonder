export type PurchaseMode = 'standard' | 'blind_box'

type PackagePricesLike = { set?: unknown } | null | undefined

/** Solid / Window box listings and single-variant items use standard purchase (no packaging picker). */
export function classifyPurchaseMode(
  productType?: string | null,
  packagePrices?: PackagePricesLike,
): PurchaseMode {
  const t = String(productType || '').trim().toLowerCase()
  const hasSet = Boolean(packagePrices?.set)

  if (/\bsolid\b/.test(t) && /\bbox\b/.test(t)) return 'standard'
  if (/\bwindow\b/.test(t) && /\bbox\b/.test(t)) return 'standard'
  if (/\bblind\b/.test(t) && /\bbox\b/.test(t)) {
    return hasSet ? 'blind_box' : 'standard'
  }

  return hasSet ? 'blind_box' : 'standard'
}
