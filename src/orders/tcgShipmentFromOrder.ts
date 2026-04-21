import { getTcgConfig } from './tcgConfig'

type Cfg = ReturnType<typeof getTcgConfig>

export type OrderShipmentRow = {
  id: string
  reference_code: string
  status: string
  delivery_method: string
  contact_phone: string | null
  contact_email: string | null
  shipping_snapshot_name: string | null
  shipping_snapshot_line1: string | null
  shipping_snapshot_line2: string | null
  pudo_locker_name: string | null
  pudo_locker_address: string | null
  tcg_shipment_id: string | null
}

export type OrderLineRow = {
  title: string
  quantity: number
}

function todayMinDate(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parcelDescription(lines: OrderLineRow[]): string {
  const s = lines
    .map((l) => `${l.title} x${l.quantity}`)
    .join('; ')
    .trim()
  return s.slice(0, 240) || 'WonderPort order'
}

function deliveryContact(order: OrderShipmentRow): { name: string; mobile_number: string; email: string } {
  const name = (order.shipping_snapshot_name || 'Customer').trim().slice(0, 120)
  const email = (order.contact_email || '').trim().slice(0, 200)
  const mobile = (order.contact_phone || '').replace(/[^\d+]/g, '').slice(0, 20)
  return {
    name,
    mobile_number: mobile,
    email,
  }
}

function collectionBlock(cfg: Cfg) {
  const addr = cfg.collectionAddress!
  const contact = cfg.collectionContact!
  return {
    collection_address: {
      type: addr.type || 'business',
      company: addr.company || '',
      street_address: addr.street_address || '',
      local_area: addr.local_area || '',
      city: addr.city || '',
      zone: addr.zone || '',
      country: addr.country || 'ZA',
      code: addr.code || '',
      ...(addr.lat != null && addr.lng != null ? { lat: addr.lat, lng: addr.lng } : {}),
    },
    collection_contact: {
      name: contact.name || 'Dispatch',
      mobile_number: contact.mobile_number || '',
      email: contact.email || '',
    },
  }
}

function sharedDatesAndWindows() {
  const min = todayMinDate()
  return {
    collection_min_date: min,
    delivery_min_date: min,
    collection_after: '08:00',
    collection_before: '17:00',
    delivery_after: '08:00',
    delivery_before: '17:00',
  }
}

function parcels(cfg: Cfg, lines: OrderLineRow[]) {
  return [
    {
      parcel_description: parcelDescription(lines),
      submitted_length_cm: cfg.parcel.lengthCm,
      submitted_width_cm: cfg.parcel.widthCm,
      submitted_height_cm: cfg.parcel.heightCm,
      submitted_weight_kg: cfg.parcel.weightKg,
    },
  ]
}

export function buildTcgRatesBody(order: OrderShipmentRow, lines: OrderLineRow[], cfg: Cfg): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...collectionBlock(cfg),
    ...sharedDatesAndWindows(),
    parcels: parcels(cfg, lines),
  }

  if (order.delivery_method === 'pudo' && cfg.pudoDeliveryPickupPointId) {
    base.delivery_pickup_point_id = cfg.pudoDeliveryPickupPointId
  } else {
    base.delivery_address = doorDeliveryAddress(order)
  }

  return base
}

function doorDeliveryAddress(order: OrderShipmentRow): Record<string, unknown> {
  const line1 = (order.shipping_snapshot_line1 || '').trim()
  const line2 = (order.shipping_snapshot_line2 || '').trim()
  const name = (order.shipping_snapshot_name || '').trim()

  if (order.delivery_method === 'pudo') {
    const locker = [order.pudo_locker_name, order.pudo_locker_address].filter(Boolean).join(', ')
    const entered = [name, `Pudo locker: ${locker}`, line1, line2].filter(Boolean).join('\n')
    return {
      type: 'locker',
      company: name || '',
      entered_address: entered.slice(0, 500),
      country: 'ZA',
    }
  }

  const entered = [name, line1, line2].filter(Boolean).join(', ')
  return {
    type: 'residential',
    company: name || '',
    entered_address: entered.slice(0, 500),
    country: 'ZA',
  }
}

export function buildTcgShipmentBody(
  order: OrderShipmentRow,
  lines: OrderLineRow[],
  cfg: Cfg,
  serviceLevelCode: string
): Record<string, unknown> {
  const dc = deliveryContact(order)
  const base: Record<string, unknown> = {
    ...collectionBlock(cfg),
    ...sharedDatesAndWindows(),
    parcels: parcels(cfg, lines),
    service_level_code: serviceLevelCode,
    customer_reference: order.reference_code,
    customer_reference_name: 'WonderPort order',
    mute_notifications: cfg.muteNotifications,
    ...(cfg.specialInstructionsCollection
      ? { special_instructions_collection: cfg.specialInstructionsCollection }
      : {}),
    ...(cfg.specialInstructionsDelivery
      ? { special_instructions_delivery: cfg.specialInstructionsDelivery }
      : {}),
  }

  if (order.delivery_method === 'pudo' && cfg.pudoDeliveryPickupPointId) {
    return {
      ...base,
      delivery_pickup_point_id: cfg.pudoDeliveryPickupPointId,
      delivery_contact: {
        name: dc.name,
        mobile_number: dc.mobile_number,
        email: dc.email,
      },
    }
  }

  return {
    ...base,
    delivery_address: doorDeliveryAddress(order),
    delivery_contact: {
      name: dc.name,
      mobile_number: dc.mobile_number,
      email: dc.email,
    },
  }
}

export function pickServiceLevelCodeFromRatesJson(data: unknown): string | null {
  const rows: unknown[] = []
  if (Array.isArray(data)) rows.push(...data)
  else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (Array.isArray(o.rates)) rows.push(...o.rates)
    else if (Array.isArray(o.data)) rows.push(...o.data)
    else if (Array.isArray(o.results)) rows.push(...o.results)
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const code = r.service_level_code ?? r.serviceLevelCode
    if (typeof code === 'string' && code.trim()) return code.trim()
  }
  return null
}
