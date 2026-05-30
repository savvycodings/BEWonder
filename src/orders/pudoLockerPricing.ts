import { lockerTierToParcel, type TcgLockerTier } from '../products/shippingDimensions'

export const PUDO_LOCKER_TIERS = ['xs', 's', 'm', 'l', 'xl'] as const
export type PudoLockerTier = (typeof PUDO_LOCKER_TIERS)[number]

/** ZAR shipping cents by customer-selected locker size. */
export const PUDO_LOCKER_SHIPPING_CENTS_ZAR: Record<PudoLockerTier, number> = {
  xs: 6000,
  s: 7000,
  m: 12000,
  l: 16000,
  xl: 22000,
}

export const PUDO_LOCKER_LABELS: Record<PudoLockerTier, string> = {
  xs: 'Extra small',
  s: 'Small',
  m: 'Medium',
  l: 'Large',
  xl: 'Extra large',
}

export function isValidPudoLockerTier(value: string): value is PudoLockerTier {
  return (PUDO_LOCKER_TIERS as readonly string[]).includes(value)
}

export function pudoLockerTierForSetOnly(tier: PudoLockerTier): boolean {
  return tier === 'l' || tier === 'xl'
}

export function orderHasWholeSetLine(lines: { packaging: string }[]): boolean {
  return lines.some((l) => l.packaging === 'set')
}

export function shippingCentsForPudoTier(tier: PudoLockerTier): number {
  return PUDO_LOCKER_SHIPPING_CENTS_ZAR[tier]
}

export function pudoLockerTierLabel(tier: string | null | undefined): string {
  const t = String(tier || '').trim().toLowerCase()
  if (isValidPudoLockerTier(t)) return PUDO_LOCKER_LABELS[t]
  return t ? t.toUpperCase() : '—'
}

export function parcelDimensionsForCustomerTier(tier: PudoLockerTier): {
  lengthCm: number
  widthCm: number
  heightCm: number
  weightKg: number
  lockerTier: PudoLockerTier
} {
  const dims = lockerTierToParcel(tier as TcgLockerTier)
  if (!dims) {
    const fallback = lockerTierToParcel('xs' as TcgLockerTier)!
    return { ...fallback, weightKg: 2, lockerTier: 'xs' }
  }
  return { ...dims, weightKg: 2, lockerTier: tier }
}
