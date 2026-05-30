import 'dotenv/config'

const domain = process.env.SHOPIFY_STORE_DOMAIN
const pub = process.env.SHOPIFY_STOREFRONT_PUBLIC_TOKEN
const admin = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN
const version = process.env.SHOPIFY_STOREFRONT_API_VERSION || '2025-01'

const sfQuery = `
  query {
    products(first: 5) {
      edges {
        node {
          handle
          title
          variants(first: 3) {
            edges {
              node {
                title
                weight
                weightUnit
              }
            }
          }
        }
      }
    }
  }
`

const sf = await fetch(`https://${domain}/api/${version}/graphql.json`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Storefront-Access-Token': pub,
  },
  body: JSON.stringify({ query: sfQuery }),
})
console.log('--- Storefront (weight only) ---')
console.log(JSON.stringify(await sf.json(), null, 2))

const adminQuery = `
  query {
    products(first: 3) {
      edges {
        node {
          handle
          variants(first: 2) {
            edges {
              node {
                title
                inventoryItem {
                  measurement {
                    weight { value unit }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`

const adm = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': admin,
  },
  body: JSON.stringify({ query: adminQuery }),
})
console.log('--- Admin (inventory weight) ---')
console.log(JSON.stringify(await adm.json(), null, 2))
