/** The Courier Guy locker compartment sizes (sorted L × W × H cm). Max 20 kg per parcel. */
export const TCG_LOCKER_TIERS = [
  { tier: 'xs' as const, lengthCm: 60, widthCm: 17, heightCm: 8, maxWeightKg: 20 },
  { tier: 's' as const, lengthCm: 60, widthCm: 26, heightCm: 18, maxWeightKg: 20 },
  { tier: 'm' as const, lengthCm: 60, widthCm: 32, heightCm: 32, maxWeightKg: 20 },
  { tier: 'l' as const, lengthCm: 60, widthCm: 38, heightCm: 52, maxWeightKg: 20 },
  { tier: 'xl' as const, lengthCm: 60, widthCm: 41, heightCm: 69, maxWeightKg: 20 },
] as const

export type TcgLockerTier = (typeof TCG_LOCKER_TIERS)[number]['tier'] | 'oversize'

export type ParcelDimensions = {
  lengthCm: number
  widthCm: number
  heightCm: number
  weightKg: number
}

export type ShippingProfile = ParcelDimensions & {
  lockerTier: TcgLockerTier
  pudoEligible: boolean
}

function sortDesc(a: number, b: number, c: number): [number, number, number] {
  return [a, b, c].sort((x, y) => y - x) as [number, number, number]
}

function fitsInLocker(
  parcel: [number, number, number],
  locker: [number, number, number]
): boolean {
  const [pL, pW, pH] = parcel
  const [lL, lW, lH] = locker
  return pL <= lL && pW <= lW && pH <= lH
}

export function pickLockerTier(
  lengthCm: number,
  widthCm: number,
  heightCm: number,
  weightKg: number
): TcgLockerTier {
  if (weightKg > 20) return 'oversize'
  const parcel = sortDesc(lengthCm, widthCm, heightCm)
  for (const locker of TCG_LOCKER_TIERS) {
    const box = sortDesc(locker.lengthCm, locker.widthCm, locker.heightCm)
    if (fitsInLocker(parcel, box) && weightKg <= locker.maxWeightKg) {
      return locker.tier
    }
  }
  return 'oversize'
}

export function lockerTierToParcel(tier: TcgLockerTier): ParcelDimensions | null {
  if (tier === 'oversize') return null
  const row = TCG_LOCKER_TIERS.find((t) => t.tier === tier)
  if (!row) return null
  return {
    lengthCm: row.lengthCm,
    widthCm: row.widthCm,
    heightCm: row.heightCm,
    weightKg: 1,
  }
}

export function normalizeWeightToKg(value: number, unit: string | null | undefined): number {
  const u = String(unit || 'KILOGRAMS').toUpperCase()
  if (u === 'GRAMS' || u === 'G') return value / 1000
  if (u === 'OUNCES' || u === 'OZ') return value * 0.0283495
  if (u === 'POUNDS' || u === 'LB' || u === 'LBS') return value * 0.453592
  return value
}

export function inferVariantPackaging(title: string): 'single' | 'set' | 'standard' {
  const t = String(title || '').toLowerCase()
  if (/\bwhole\s*set\b/.test(t) || /\b(set of|full set)\b/.test(t)) return 'set'
  if (/\bsingle\b/.test(t) || /\bblind box\b/.test(t)) return 'single'
  return 'standard'
}

export function buildShippingProfile(
  dims: Partial<ParcelDimensions>,
  fallback: ParcelDimensions
): ShippingProfile {
  const lengthCm = positiveOr(dims.lengthCm, fallback.lengthCm)
  const widthCm = positiveOr(dims.widthCm, fallback.widthCm)
  const heightCm = positiveOr(dims.heightCm, fallback.heightCm)
  const weightKg = positiveOr(dims.weightKg, fallback.weightKg)
  const lockerTier = pickLockerTier(lengthCm, widthCm, heightCm, weightKg)
  return {
    lengthCm,
    widthCm,
    heightCm,
    weightKg,
    lockerTier,
    pudoEligible: lockerTier !== 'oversize',
  }
}

function positiveOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Combine cart lines into one parcel (stack height, max footprint). */
export function combineParcelProfiles(
  lines: ShippingProfile[],
  quantities: number[]
): ShippingProfile {
  if (!lines.length) {
    return buildShippingProfile({}, defaultParcelFromEnv())
  }

  let maxL = 0
  let maxW = 0
  let sumH = 0
  let sumWeight = 0

  lines.forEach((line, i) => {
    const qty = Math.max(1, quantities[i] || 1)
    const sorted = sortDesc(line.lengthCm, line.widthCm, line.heightCm)
    maxL = Math.max(maxL, sorted[0])
    maxW = Math.max(maxW, sorted[1])
    sumH += sorted[2] * qty
    sumWeight += line.weightKg * qty
  })

  return buildShippingProfile(
    { lengthCm: maxL, widthCm: maxW, heightCm: sumH, weightKg: sumWeight },
    defaultParcelFromEnv()
  )
}

export function defaultParcelFromEnv(): ParcelDimensions {
  return {
    lengthCm: numEnv('TCG_DEFAULT_PARCEL_LENGTH_CM', 60),
    widthCm: numEnv('TCG_DEFAULT_PARCEL_WIDTH_CM', 17),
    heightCm: numEnv('TCG_DEFAULT_PARCEL_HEIGHT_CM', 8),
    weightKg: numEnv('TCG_DEFAULT_PARCEL_WEIGHT_KG', 1),
  }
}

export function defaultSetParcelFromEnv(): ParcelDimensions {
  return {
    lengthCm: numEnv('TCG_DEFAULT_SET_PARCEL_LENGTH_CM', 60),
    widthCm: numEnv('TCG_DEFAULT_SET_PARCEL_WIDTH_CM', 41),
    heightCm: numEnv('TCG_DEFAULT_SET_PARCEL_HEIGHT_CM', 17),
    weightKg: numEnv('TCG_DEFAULT_SET_PARCEL_WEIGHT_KG', 5),
  }
}

function numEnv(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function shippingProfileToApi(profile: ShippingProfile) {
  return {
    weightKg: profile.weightKg,
    lengthCm: profile.lengthCm,
    widthCm: profile.widthCm,
    heightCm: profile.heightCm,
    lockerTier: profile.lockerTier,
    pudoEligible: profile.pudoEligible,
  }
}

export function rowToShippingProfile(row: {
  length_cm?: unknown
  width_cm?: unknown
  height_cm?: unknown
  weight_kg?: unknown
  locker_tier?: unknown
}): ShippingProfile | null {
  const lengthCm = numOrNull(row.length_cm)
  const widthCm = numOrNull(row.width_cm)
  const heightCm = numOrNull(row.height_cm)
  const weightKg = numOrNull(row.weight_kg)
  if (lengthCm == null && widthCm == null && heightCm == null && weightKg == null) {
    return null
  }
  return buildShippingProfile(
    {
      lengthCm: lengthCm ?? undefined,
      widthCm: widthCm ?? undefined,
      heightCm: heightCm ?? undefined,
      weightKg: weightKg ?? undefined,
    },
    defaultParcelFromEnv()
  )
}

function numOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}
