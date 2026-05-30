import 'dotenv/config'
import { pool } from './client'
import { syncShopifyCatalogToDb } from '../shopify/syncCatalog'

async function main() {
  const result = await syncShopifyCatalogToDb()
  console.log(
    `Shopify catalog sync complete: ${result.products} products, ${result.variants} variants (with shipping dimensions).`
  )
}

main()
  .catch((error) => {
    console.error('Shopify catalog sync failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
