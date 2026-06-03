import { lockerTierToParcel, type TcgLockerTier } from '../products/shippingDimensions'

export const PUDO_LOCKER_TIERS = ['locker', 'door'] as const
export type PudoLockerTier = (typeof PUDO_LOCKER_TIERS)[number]

/** ZAR shipping cents by customer-selected delivery option. */
export const PUDO_LOCKER_SHIPPING_CENTS_ZAR: Record<PudoLockerTier, number> = {
  locker: 9000,
  door: 11000,
}

/** ZAR subtotal (cents) at or above which Pudo delivery is free. R1,000 = 100_000 cents. */
export const FREE_DELIVERY_SUBTOTAL_CENTS_ZAR = 100_000

export function qualifiesForFreeDeliveryZar(
  subtotalCents: number,
  currency: string,
): boolean {
  return (
    String(currency || '').trim().toUpperCase() === 'ZAR' &&
    Number.isFinite(subtotalCents) &&
    subtotalCents >= FREE_DELIVERY_SUBTOTAL_CENTS_ZAR
  )
}

export const PUDO_LOCKER_LABELS: Record<PudoLockerTier, string> = {
  locker: 'Locker',
  door: 'Door',
}

const TCG_TIER_FOR_CUSTOMER: Record<PudoLockerTier, TcgLockerTier> = {
  locker: 's',
  door: 'l',
}

/** @deprecated Legacy tiers — accepted for existing orders only. */
const LEGACY_TIERS = ['xs', 's', 'm', 'l', 'xl'] as const

const LEGACY_TIER_LABELS: Record<string, string> = {
  xs: 'Extra small',
  s: 'Small',
  m: 'Medium',
  l: 'Large',
  xl: 'Extra large',
}

const LEGACY_SHIPPING_CENTS: Record<string, number> = {
  xs: 6000,
  s: 7000,
  m: 12000,
  l: 16000,
  xl: 22000,
}

export function isValidPudoLockerTier(value: string): value is PudoLockerTier {
  return (PUDO_LOCKER_TIERS as readonly string[]).includes(value)
}

export function isKnownPudoLockerTier(value: string): boolean {
  const t = String(value || '').trim().toLowerCase()
  return isValidPudoLockerTier(t) || (LEGACY_TIERS as readonly string[]).includes(t)
}

export function pudoLockerTierForSetOnly(tier: string): boolean {
  if (tier === 'door') return true
  return tier === 'l' || tier === 'xl'
}

export function orderHasWholeSetLine(lines: { packaging: string }[]): boolean {
  return lines.some((l) => l.packaging === 'set')
}

export function shippingCentsForPudoTier(tier: string): number {
  const t = String(tier || '').trim().toLowerCase()
  if (isValidPudoLockerTier(t)) return PUDO_LOCKER_SHIPPING_CENTS_ZAR[t]
  if (LEGACY_SHIPPING_CENTS[t] != null) return LEGACY_SHIPPING_CENTS[t]
  return PUDO_LOCKER_SHIPPING_CENTS_ZAR.locker
}

export function shippingCentsForOrder(
  subtotalCents: number,
  currency: string,
  tier: string,
): number {
  if (qualifiesForFreeDeliveryZar(subtotalCents, currency)) return 0
  return shippingCentsForPudoTier(tier)
}

export function pudoLockerTierLabel(tier: string | null | undefined): string {
  const t = String(tier || '').trim().toLowerCase()
  if (isValidPudoLockerTier(t)) {
    return `${PUDO_LOCKER_LABELS[t]} (R${PUDO_LOCKER_SHIPPING_CENTS_ZAR[t] / 100})`
  }
  if (LEGACY_TIER_LABELS[t]) return LEGACY_TIER_LABELS[t]
  return t ? t.toUpperCase() : '—'
}

export function parcelDimensionsForCustomerTier(tier: string): {
  lengthCm: number
  widthCm: number
  heightCm: number
  weightKg: number
  lockerTier: string
} {
  const t = String(tier || '').trim().toLowerCase()
  const tcgTier: TcgLockerTier = isValidPudoLockerTier(t)
    ? TCG_TIER_FOR_CUSTOMER[t]
    : (LEGACY_TIERS as readonly string[]).includes(t as (typeof LEGACY_TIERS)[number])
      ? (t as TcgLockerTier)
      : 's'

  const dims = lockerTierToParcel(tcgTier)
  if (!dims) {
    const fallback = lockerTierToParcel('s')!
    return { ...fallback, weightKg: 2, lockerTier: tcgTier }
  }
  return { ...dims, weightKg: 2, lockerTier: tcgTier }
}
