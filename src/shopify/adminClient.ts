type AdminConfig = {
  domain: string
  token: string
  version: string
}

export function getShopifyAdminConfig(): AdminConfig | null {
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '').trim()
  const token = String(
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
      process.env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN ||
      ''
  ).trim()
  const version = String(process.env.SHOPIFY_ADMIN_API_VERSION || '2025-01').trim()
  if (!domain || !token || !token.startsWith('shpat_')) return null
  return { domain, token, version }
}

export async function shopifyAdminRequest<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const cfg = getShopifyAdminConfig()
  if (!cfg) {
    throw new Error(
      'Shopify Admin API is not configured. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN (shpat_… with read_products + read_inventory).'
    )
  }

  const resp = await fetch(
    `https://${cfg.domain}/admin/api/${cfg.version}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': cfg.token,
      },
      body: JSON.stringify({ query, variables }),
    }
  )

  const json = (await resp.json()) as {
    data?: T
    errors?: { message: string }[]
  }

  if (!resp.ok) {
    throw new Error(json?.errors?.[0]?.message || `Shopify Admin HTTP ${resp.status}`)
  }
  if (json?.errors?.length) {
    throw new Error(json.errors[0]?.message || 'Shopify Admin GraphQL error')
  }
  if (!json.data) {
    throw new Error('Shopify Admin returned no data')
  }
  return json.data
}
