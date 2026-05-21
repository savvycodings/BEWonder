/** Shopify-synced inventory fields on `products`. */

export function parseTotalInventory(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number.parseFloat(String(raw))
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.floor(n))
}

export function isProductInStock(
  totalInventory: number | null,
  availableForSale: boolean | null | undefined,
): boolean {
  if (availableForSale === false) return false
  if (totalInventory == null) return false
  return totalInventory > 0
}

export function stockFieldsFromRow(row: {
  total_inventory?: unknown
  available_for_sale?: boolean | null
}) {
  const totalInventory = parseTotalInventory(row.total_inventory)
  const availableForSale = row.available_for_sale !== false
  const inStock = isProductInStock(totalInventory, row.available_for_sale)
  return { totalInventory, availableForSale, inStock }
}
