/**
 * End-to-end Pudo / TCG flow verification (no live shipment creation).
 * Run: node scripts/test-pudo-flow.mjs
 */
import 'dotenv/config'
import { pool } from '../dist/db/client.js'
import { getTcgConfig, tcgConfigReadyForShipment } from '../dist/orders/tcgConfig.js'
import {
  buildTcgRatesBody,
  buildTcgShipmentBody,
  computeParcelForOrder,
  parcelSnapshotFromLines,
  pickServiceLevelCodeFromRatesJson,
} from '../dist/orders/tcgShipmentFromOrder.js'
import { tcgPostJson } from '../dist/orders/tcgClient.js'
import { combineParcelProfiles, rowToShippingProfile } from '../dist/products/shippingDimensions.js'

const results = []

function pass(name, detail) {
  results.push({ status: 'PASS', name, detail })
  console.log(`✓ ${name}${detail ? `: ${detail}` : ''}`)
}

function fail(name, detail) {
  results.push({ status: 'FAIL', name, detail })
  console.log(`✗ ${name}: ${detail}`)
}

function warn(name, detail) {
  results.push({ status: 'WARN', name, detail })
  console.log(`⚠ ${name}: ${detail}`)
}

function info(name, detail) {
  results.push({ status: 'INFO', name, detail })
  console.log(`  ${name}: ${detail}`)
}

// ── 1. Config ──────────────────────────────────────────────────────────────
const cfg = getTcgConfig()
if (cfg.enabled) pass('TCG enabled')
else fail('TCG enabled', 'TCG_ENABLED must be true with API key and base URL')

if (tcgConfigReadyForShipment()) pass('TCG ready for shipment')
else fail('TCG ready for shipment', 'Missing collection address/contact or invalid config')

if (cfg.pudoDeliveryPickupPointId) {
  pass('Pudo pickup point ID configured', cfg.pudoDeliveryPickupPointId)
} else {
  warn(
    'Pudo pickup point ID',
    'TCG_PUDO_DELIVERY_PICKUP_POINT_ID not set — bookings use text locker address fallback, not tcg-locker API'
  )
}

if (cfg.serviceLevelCode) pass('Service level code', cfg.serviceLevelCode)
else warn('Service level code', 'TCG_SERVICE_LEVEL_CODE not set — will call /rates at booking time')

// ── 2. Product catalog + dimensions ──────────────────────────────────────
const productRes = await pool.query(`
  SELECT p.id, p.handle, p.title,
         p.length_cm, p.width_cm, p.height_cm, p.weight_kg, p.locker_tier,
         v.id AS variant_id, v.title AS variant_title, v.packaging,
         v.length_cm AS v_len, v.width_cm AS v_w, v.height_cm AS v_h, v.weight_kg AS v_wt
  FROM products p
  JOIN product_variants v ON v.product_id = p.id
  WHERE p.length_cm IS NOT NULL
    AND p.available_for_sale = true
    AND (p.total_inventory::int > 0 OR p.total_inventory IS NULL)
  ORDER BY p.id DESC
  LIMIT 1
`)

if (!productRes.rows.length) {
  fail('Pudo-eligible product in DB', 'No in-stock product with dimensions found')
} else {
  const p = productRes.rows[0]
  pass('Sample in-stock product', `${p.handle} (id ${p.id})`)

  const profile = rowToShippingProfile({
    length_cm: p.v_len ?? p.length_cm,
    width_cm: p.v_w ?? p.width_cm,
    height_cm: p.v_h ?? p.height_cm,
    weight_kg: p.v_wt ?? p.weight_kg,
    locker_tier: p.locker_tier,
  })

  if (profile?.pudoEligible) {
    pass('Product Pudo eligible', `${profile.lengthCm}×${profile.widthCm}×${profile.heightCm} cm, ${profile.weightKg} kg, tier ${profile.lockerTier}`)
  } else {
    fail('Product Pudo eligible', `Profile: ${JSON.stringify(profile)}`)
  }

  // Simulate checkout oversize guard (same logic as ordersRouter)
  const combined = combineParcelProfiles([profile], [1])
  if (combined.pudoEligible) pass('Checkout Pudo guard (1× single)', `combined tier ${combined.lockerTier}`)
  else fail('Checkout Pudo guard (1× single)', 'Would reject at checkout')

  // Simulate 3× same item (stress test stacking)
  const combined3 = combineParcelProfiles([profile, profile, profile], [1, 1, 1])
  info('3-line cart combined parcel', `${combined3.lengthCm}×${combined3.widthCm}×${combined3.heightCm} cm, ${combined3.weightKg} kg, tier ${combined3.lockerTier}`)
  if (combined3.pudoEligible) pass('Checkout Pudo guard (3× same item)')
  else warn('Checkout Pudo guard (3× same item)', 'Would block Pudo for qty 3 — expected for large stacks')

  // ── 3. Parcel → TCG payload ──────────────────────────────────────────────
  const mockOrder = {
    id: '00000000-0000-0000-0000-000000000001',
    reference_code: 'WP-TEST-PUDO',
    status: 'paid',
    delivery_method: 'pudo',
    contact_phone: '+27821234567',
    contact_email: 'test@example.com',
    shipping_snapshot_name: 'Test User',
    shipping_snapshot_line1: 'Locker ABC123',
    shipping_snapshot_line2: 'Sandton City, Johannesburg',
    pudo_locker_name: 'Pudo Locker Sandton',
    pudo_locker_address: 'Sandton City, Johannesburg',
    tcg_shipment_id: null,
  }

  const mockLines = [
    {
      title: p.title,
      quantity: 1,
      packaging: p.packaging === 'set' ? 'set' : 'single',
      length_cm: Number(p.v_len ?? p.length_cm),
      width_cm: Number(p.v_w ?? p.width_cm),
      height_cm: Number(p.v_h ?? p.height_cm),
      weight_kg: Number(p.v_wt ?? p.weight_kg),
      locker_tier: p.locker_tier,
    },
  ]

  const parcel = computeParcelForOrder(mockLines, cfg)
  const snapshot = parcelSnapshotFromLines(mockLines, cfg)
  pass('Parcel computed for order lines', `${snapshot.lengthCm}×${snapshot.widthCm}×${snapshot.heightCm} cm, ${snapshot.weightKg} kg`)

  const ratesBody = buildTcgRatesBody(mockOrder, mockLines, cfg)
  const shipmentBodyPreview = buildTcgShipmentBody(mockOrder, mockLines, cfg, cfg.serviceLevelCode || 'PLACEHOLDER')

  if (ratesBody.parcels?.[0]?.submitted_length_cm) {
    pass('TCG rates body has parcel dimensions', JSON.stringify(ratesBody.parcels[0]))
  } else {
    fail('TCG rates body parcels', JSON.stringify(ratesBody.parcels))
  }

  if (cfg.pudoDeliveryPickupPointId) {
    if (ratesBody.delivery_pickup_point_provider === 'tcg-locker') {
      pass('Rates body uses tcg-locker provider')
    } else {
      fail('Rates body provider', 'Expected tcg-locker when pickup point ID set')
    }
  } else {
    if (ratesBody.delivery_address) {
      warn('Rates body delivery', 'Using delivery_address fallback (no pickup point ID)')
    }
  }

  // ── 4. Live TCG /rates (no shipment created) ─────────────────────────────
  if (tcgConfigReadyForShipment()) {
    const ratesRes = await tcgPostJson('/rates', ratesBody)
    if (ratesRes.ok) {
      const code = pickServiceLevelCodeFromRatesJson(ratesRes.data)
      pass('TCG /rates API', code ? `service_level_code=${code}` : 'OK but no service level in response')
      if (!code && !cfg.serviceLevelCode) {
        warn('Service level from rates', 'Set TCG_SERVICE_LEVEL_CODE if /rates response has no code')
      }

      // Validate shipment body shape (do NOT POST /shipments)
      const finalBody = buildTcgShipmentBody(mockOrder, mockLines, cfg, code || cfg.serviceLevelCode || 'ECO')
      if (finalBody.service_level_code && finalBody.parcels?.length) {
        pass('Shipment body ready (dry-run)', `ref=${finalBody.customer_reference}, parcels=${finalBody.parcels.length}`)
      } else {
        fail('Shipment body shape', JSON.stringify(Object.keys(finalBody)))
      }
    } else {
      fail('TCG /rates API', ratesRes.error)
    }
  }
}

// ── 5. Recent real Pudo orders in DB ───────────────────────────────────────
const ordersRes = await pool.query(`
  SELECT reference_code, status, delivery_method,
         pudo_locker_name, pudo_locker_address,
         tcg_shipment_id, tcg_short_tracking_reference,
         tcg_locker_tier, tcg_parcel_length_cm, tcg_parcel_width_cm,
         tcg_parcel_height_cm, tcg_parcel_weight_kg, tcg_last_error,
         created_at
  FROM orders
  WHERE delivery_method = 'pudo'
  ORDER BY created_at DESC
  LIMIT 5
`)

if (!ordersRes.rows.length) {
  warn('Historical Pudo orders', 'None in database yet')
} else {
  pass('Historical Pudo orders', `${ordersRes.rows.length} recent (showing latest)`)
  for (const o of ordersRes.rows) {
    const booked = o.tcg_shipment_id ? `booked ${o.tcg_shipment_id}` : 'not booked'
    const parcel = o.tcg_parcel_length_cm
      ? `${o.tcg_parcel_length_cm}×${o.tcg_parcel_width_cm}×${o.tcg_parcel_height_cm} cm ${o.tcg_parcel_weight_kg}kg tier=${o.tcg_locker_tier}`
      : 'no parcel snapshot'
    info(o.reference_code, `${o.status} | ${booked} | ${parcel}${o.tcg_last_error ? ` | err: ${o.tcg_last_error.slice(0, 80)}` : ''}`)
    if (o.status === 'paid' && !o.tcg_shipment_id && o.tcg_last_error) {
      fail(`Order ${o.reference_code} TCG booking`, o.tcg_last_error.slice(0, 200))
    } else if (o.status === 'paid' && o.tcg_shipment_id) {
      pass(`Order ${o.reference_code} TCG booked`, o.tcg_short_tracking_reference || o.tcg_shipment_id)
    } else if (o.status === 'paid' && !o.tcg_shipment_id && !o.tcg_last_error) {
      warn(`Order ${o.reference_code}`, 'Paid but no TCG shipment — TCG may have been off at payment time')
    }
  }
}

// ── 6. Production API smoke ────────────────────────────────────────────────
try {
  const prodUrl = 'https://bewonder-production.up.railway.app/products?first=1'
  const res = await fetch(prodUrl)
  if (res.ok) {
    const j = await res.json()
    const prod = j.products?.[0]
    if (prod?.shipping) pass('Production API exposes shipping', JSON.stringify(prod.shipping))
    else warn('Production API shipping field', 'Not deployed yet — redeploy server for app to see dimensions')
  } else {
    warn('Production API', `HTTP ${res.status}`)
  }
} catch (e) {
  warn('Production API', String(e.message))
}

// ── Summary ────────────────────────────────────────────────────────────────
const counts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 }
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1

console.log('\n── Summary ──')
console.log(`PASS ${counts.PASS} | FAIL ${counts.FAIL} | WARN ${counts.WARN}`)

await pool.end()
process.exit(counts.FAIL > 0 ? 1 : 0)
