export type TcgAddress = {
  type?: string
  company?: string
  street_address?: string
  local_area?: string
  city?: string
  zone?: string
  country?: string
  code?: string
  lat?: number
  lng?: number
  entered_address?: string
}

export type TcgContact = {
  name?: string
  mobile_number?: string
  email?: string
}

function parseJson<T>(raw: string | undefined, label: string): T | null {
  if (!raw || !String(raw).trim()) return null
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    console.warn(`[tcg] invalid JSON for ${label}`)
    return null
  }
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * ShipLogic portal sometimes shows `numericId|secretToken`. The REST API expects
 * `Authorization: Bearer <token>` where the token is usually the part AFTER the pipe.
 * Override with TCG_BEARER_TOKEN, or TCG_API_KEY_BEARER_PART=full to send the entire TCG_API_KEY.
 */
export function getTcgBearerToken(): string {
  const override = (process.env.TCG_BEARER_TOKEN || '').trim()
  if (override) return override

  const raw = (process.env.TCG_API_KEY || '').trim()
  if (!raw) return ''

  const mode = (process.env.TCG_API_KEY_BEARER_PART || 'auto').trim().toLowerCase()
  const pipe = raw.indexOf('|')
  if (pipe === -1) return raw
  if (mode === 'full') return raw
  if (mode === 'prefix') return raw.slice(0, pipe).trim()
  if (mode === 'suffix') return raw.slice(pipe + 1).trim()
  // auto: suffix after first pipe (typical id|secret)
  return raw.slice(pipe + 1).trim()
}

export function getTcgConfig() {
  const apiBase = (process.env.TCG_API_BASE_URL || '').trim().replace(/\/$/, '')
  const apiKey = (process.env.TCG_API_KEY || '').trim()
  const bearerToken = getTcgBearerToken()
  const enabled = process.env.TCG_ENABLED === 'true' && Boolean(apiBase && apiKey && bearerToken)

  return {
    enabled,
    apiBase,
    apiKey,
    bearerToken,
    accountId: (process.env.TCG_ACCOUNT_ID || '').trim(),
    webhookSecret: (process.env.TCG_WEBHOOK_SECRET || '').trim(),
    collectionAddress: parseJson<TcgAddress>(process.env.TCG_COLLECTION_ADDRESS_JSON, 'TCG_COLLECTION_ADDRESS_JSON'),
    collectionContact: parseJson<TcgContact>(process.env.TCG_COLLECTION_CONTACT_JSON, 'TCG_COLLECTION_CONTACT_JSON'),
    parcel: {
      lengthCm: num(process.env.TCG_DEFAULT_PARCEL_LENGTH_CM, 30),
      widthCm: num(process.env.TCG_DEFAULT_PARCEL_WIDTH_CM, 25),
      heightCm: num(process.env.TCG_DEFAULT_PARCEL_HEIGHT_CM, 10),
      weightKg: num(process.env.TCG_DEFAULT_PARCEL_WEIGHT_KG, 1),
    },
    serviceLevelCode: (process.env.TCG_SERVICE_LEVEL_CODE || '').trim(),
    pudoDeliveryPickupPointId: (process.env.TCG_PUDO_DELIVERY_PICKUP_POINT_ID || '').trim(),
    muteNotifications: process.env.TCG_MUTE_NOTIFICATIONS !== 'false',
    specialInstructionsCollection: (process.env.TCG_SPECIAL_INSTRUCTIONS_COLLECTION || '').trim(),
    specialInstructionsDelivery: (process.env.TCG_SPECIAL_INSTRUCTIONS_DELIVERY || '').trim(),
  }
}

export function tcgConfigReadyForShipment(): boolean {
  const c = getTcgConfig()
  if (!c.enabled) return false
  if (!c.collectionAddress || !c.collectionContact) return false
  const addr = c.collectionAddress
  const contact = c.collectionContact
  if (!addr.street_address || !addr.city || !addr.code || !addr.country) return false
  if (!contact.email && !contact.mobile_number) return false
  return true
}
