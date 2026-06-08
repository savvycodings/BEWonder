import { getShopifyAdminConfig, shopifyAdminRequest } from './adminClient'

const PRIMARY_LOCATION_QUERY = `
  query PrimaryInventoryLocation {
    locations(first: 1, query: "active:true") {
      edges {
        node { id name }
      }
    }
  }
`

const VARIANT_INVENTORY_ITEMS_QUERY = `
  query VariantInventoryItems($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        inventoryItem { id }
      }
    }
  }
`

const INVENTORY_ADJUST_MUTATION = `
  mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      userErrors { field message }
      inventoryAdjustmentGroup { createdAt }
    }
  }
`

let cachedLocationId: string | null = null

export async function getShopifyInventoryLocationId(): Promise<string> {
  const fromEnv = String(process.env.SHOPIFY_INVENTORY_LOCATION_ID || '').trim()
  if (fromEnv) return fromEnv

  if (cachedLocationId) return cachedLocationId

  const data = await shopifyAdminRequest<{
    locations: { edges: { node: { id: string; name: string } }[] }
  }>(PRIMARY_LOCATION_QUERY)

  const id = data.locations?.edges?.[0]?.node?.id
  if (!id) {
    throw new Error(
      'No active Shopify location found. Set SHOPIFY_INVENTORY_LOCATION_ID in server .env.'
    )
  }
  cachedLocationId = id
  return id
}

export type ShopifyInventoryDecreaseLine = {
  variantShopifyId: string
  quantity: number
}

/**
 * Decrease available inventory on Shopify for sold order lines.
 * Requires Admin token with write_inventory (and read_inventory).
 */
export async function decreaseShopifyInventoryForSale(
  lines: ShopifyInventoryDecreaseLine[]
): Promise<{ adjusted: number; skipped: number }> {
  if (!getShopifyAdminConfig()) {
    throw new Error(
      'Shopify Admin API is not configured (SHOPIFY_ADMIN_ACCESS_TOKEN shpat_… with write_inventory).'
    )
  }

  const byVariant = new Map<string, number>()
  for (const line of lines) {
    const id = String(line.variantShopifyId || '').trim()
    if (!id) continue
    const qty = Math.max(1, Math.floor(line.quantity))
    byVariant.set(id, (byVariant.get(id) || 0) + qty)
  }

  if (!byVariant.size) {
    return { adjusted: 0, skipped: lines.length }
  }

  const variantIds = [...byVariant.keys()]
  const locationId = await getShopifyInventoryLocationId()

  const nodesData = await shopifyAdminRequest<{
    nodes: Array<{ id?: string; inventoryItem?: { id: string } | null } | null>
  }>(VARIANT_INVENTORY_ITEMS_QUERY, { ids: variantIds })

  const changes: { inventoryItemId: string; locationId: string; delta: number }[] = []
  for (const node of nodesData.nodes) {
    if (!node?.id || !node.inventoryItem?.id) continue
    const delta = byVariant.get(node.id)
    if (!delta) continue
    changes.push({
      inventoryItemId: node.inventoryItem.id,
      locationId,
      delta: -delta,
    })
  }

  if (!changes.length) {
    throw new Error('Could not resolve Shopify inventory items for these variants.')
  }

  const adjustData = await shopifyAdminRequest<{
    inventoryAdjustQuantities: {
      userErrors: { field: string[] | null; message: string }[]
      inventoryAdjustmentGroup: { createdAt: string } | null
    }
  }>(INVENTORY_ADJUST_MUTATION, {
    input: {
      reason: 'correction',
      name: 'available',
      changes,
    },
  })

  const errors = adjustData.inventoryAdjustQuantities?.userErrors || []
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join('; ') || 'Shopify inventory adjust failed')
  }

  return { adjusted: changes.length, skipped: variantIds.length - changes.length }
}
