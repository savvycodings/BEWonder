type ShopifyMoneyV2 = {
  amount: string
  currencyCode: string
}

export type ShopifyProductSummary = {
  id: string
  handle: string
  title: string
  descriptionHtml: string | null
  vendor: string | null
  productType: string | null
  tags: string[]
  featuredImageUrl: string | null
  price: ShopifyMoneyV2 | null
  compareAtPrice: ShopifyMoneyV2 | null
}

export type ShopifyCollectionSummary = {
  id: string
  title: string
  handle: string
  imageUrl: string | null
}

function getStorefrontConfig() {
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '').trim()
  const token = String(process.env.SHOPIFY_STOREFRONT_PUBLIC_TOKEN || '').trim()
  const version = String(process.env.SHOPIFY_STOREFRONT_API_VERSION || '2025-01').trim()

  if (!domain) {
    throw new Error('SHOPIFY_STORE_DOMAIN is not configured')
  }
  if (!token) {
    throw new Error('SHOPIFY_STOREFRONT_PUBLIC_TOKEN is not configured')
  }

  const endpoint = `https://${domain}/api/${version}/graphql.json`
  return { endpoint, token }
}

async function storefrontRequest<T>(query: string, variables: Record<string, any>) {
  const { endpoint, token } = getStorefrontConfig()

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  })

  const json = (await resp.json()) as any
  if (!resp.ok) {
    const msg = json?.errors?.[0]?.message || `Shopify request failed (${resp.status})`
    throw new Error(msg)
  }
  if (json?.errors?.length) {
    throw new Error(json.errors[0]?.message || 'Shopify GraphQL error')
  }
  return json.data as T
}

function firstNode<T>(connection: { edges?: { node: T }[] } | null | undefined): T | null {
  const node = connection?.edges?.[0]?.node
  return node ?? null
}

export async function listProducts(params: { first: number; query?: string }) {
  const first = Math.max(1, Math.min(50, Number(params.first) || 20))
  const query = String(params.query || '').trim()

  const gql = `
    query Products($first: Int!, $query: String) {
      products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            handle
            title
            descriptionHtml
            vendor
            productType
            tags
            featuredImage { url }
            variants(first: 1) {
              edges {
                node {
                  price { amount currencyCode }
                  compareAtPrice { amount currencyCode }
                }
              }
            }
          }
        }
      }
    }
  `

  const data = await storefrontRequest<{
    products: {
      edges: {
        node: {
          id: string
          handle: string
          title: string
          descriptionHtml: string | null
          vendor: string | null
          productType: string | null
          tags: string[]
          featuredImage: { url: string } | null
          variants: {
            edges: {
              node: {
                price: ShopifyMoneyV2
                compareAtPrice: ShopifyMoneyV2 | null
              }
            }[]
          }
        }
      }[]
    }
  }>(gql, { first, query: query || null })

  return data.products.edges.map(({ node }) => {
    const variant = firstNode(node.variants)
    return {
      id: node.id,
      handle: node.handle,
      title: node.title,
      descriptionHtml: node.descriptionHtml ?? null,
      vendor: node.vendor ?? null,
      productType: node.productType ?? null,
      tags: Array.isArray(node.tags) ? node.tags : [],
      featuredImageUrl: node.featuredImage?.url ?? null,
      price: variant?.price ?? null,
      compareAtPrice: variant?.compareAtPrice ?? null,
    } satisfies ShopifyProductSummary
  })
}

export async function getProductByHandle(handle: string) {
  const safeHandle = String(handle || '').trim()
  if (!safeHandle) return null

  const gql = `
    query ProductByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        id
        handle
        title
        descriptionHtml
        vendor
        productType
        tags
        featuredImage { url }
        variants(first: 1) {
          edges {
            node {
              price { amount currencyCode }
              compareAtPrice { amount currencyCode }
            }
          }
        }
      }
    }
  `

  const data = await storefrontRequest<{
    productByHandle: {
      id: string
      handle: string
      title: string
      descriptionHtml: string | null
      vendor: string | null
      productType: string | null
      tags: string[]
      featuredImage: { url: string } | null
      variants: {
        edges: {
          node: { price: ShopifyMoneyV2; compareAtPrice: ShopifyMoneyV2 | null }
        }[]
      }
    } | null
  }>(gql, { handle: safeHandle })

  const product = data.productByHandle
  if (!product) return null

  const variant = firstNode(product.variants)
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    descriptionHtml: product.descriptionHtml ?? null,
    vendor: product.vendor ?? null,
    productType: product.productType ?? null,
    tags: Array.isArray(product.tags) ? product.tags : [],
    featuredImageUrl: product.featuredImage?.url ?? null,
    price: variant?.price ?? null,
    compareAtPrice: variant?.compareAtPrice ?? null,
  } satisfies ShopifyProductSummary
}

export async function getCollectionsByIds(ids: string[]) {
  const safeIds = Array.from(
    new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean))
  ).slice(0, 100)
  if (!safeIds.length) return []

  const gql = `
    query CollectionsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Collection {
          id
          title
          handle
          image { url }
        }
      }
    }
  `

  const data = await storefrontRequest<{
    nodes: Array<
      | {
          id: string
          title: string
          handle: string
          image: { url: string } | null
        }
      | null
    >
  }>(gql, { ids: safeIds })

  const nodeById = new Map<string, ShopifyCollectionSummary>()
  for (const node of data.nodes || []) {
    if (!node?.id || !node?.title || !node?.handle) continue
    nodeById.set(node.id, {
      id: node.id,
      title: node.title,
      handle: node.handle,
      imageUrl: node.image?.url ?? null,
    })
  }

  return safeIds.map((id) => nodeById.get(id)).filter(Boolean) as ShopifyCollectionSummary[]
}

