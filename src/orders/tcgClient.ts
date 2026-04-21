import { getTcgConfig } from './tcgConfig'

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Parse ShipLogic / ASP.NET style JSON errors into one readable string. */
export function formatShipLogicErrorBody(status: number, text: string): string {
  const t = (text || '').trim()
  if (!t) return `HTTP ${status} (empty response body)`
  try {
    const j = JSON.parse(t) as Record<string, unknown>
    const parts: string[] = []
    const push = (s: unknown) => {
      if (typeof s === 'string' && s.trim()) parts.push(s.trim())
    }
    push(j.message)
    push(j.title)
    push(j.detail)
    push(j.error)
    if (Array.isArray(j.errors)) {
      for (const e of j.errors) {
        if (typeof e === 'string') push(e)
        else if (e && typeof e === 'object') {
          const o = e as Record<string, unknown>
          push(o.message)
          push(o.description)
        }
      }
    }
    if (typeof j.errors === 'object' && j.errors !== null && !Array.isArray(j.errors)) {
      for (const v of Object.values(j.errors as Record<string, unknown>)) {
        if (Array.isArray(v)) v.forEach((x) => push(String(x)))
      }
    }
    const uniq = [...new Set(parts)]
    if (uniq.length) return `HTTP ${status}: ${uniq.join(' | ')}`
  } catch {
    /* not JSON */
  }
  return `HTTP ${status}: ${t.slice(0, 1200)}`
}

function buildUrl(path: string): string {
  const { apiBase, accountId } = getTcgConfig()
  const p = path.startsWith('/') ? path : `/${path}`
  const url = `${apiBase}${p}`
  if (!accountId) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}account_id=${encodeURIComponent(accountId)}`
}

export type TcgJsonResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; bodyText?: string }

async function tcgFetchOnce(path: string, init: RequestInit): Promise<Response> {
  const { bearerToken } = getTcgConfig()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${bearerToken}`)
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(buildUrl(path), { ...init, headers })
}

/**
 * POST JSON with small 429 backoff (ShipLogic documents rate limits).
 */
export async function tcgPostJson<T = unknown>(path: string, body: unknown): Promise<TcgJsonResult<T>> {
  const maxAttempts = 4
  let lastStatus = 0
  let lastText = ''

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await tcgFetchOnce(path, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    lastStatus = res.status
    const text = await res.text()
    lastText = text.slice(0, 4000)

    if (res.status === 429 && attempt < maxAttempts - 1) {
      const backoff = 800 * Math.pow(2, attempt)
      await sleep(backoff)
      continue
    }

    if (!res.ok) {
      const err = formatShipLogicErrorBody(res.status, text)
      if (res.status === 401) {
        const { apiBase } = getTcgConfig()
        console.warn(
          `[tcg] HTTP 401 against ${apiBase}. Common fixes: (1) Sandbox API key must use the sandbox API host from your portal — not mixed with production. (2) If your key looks like id|secret, we send only the part after "|" as Bearer (set TCG_API_KEY_BEARER_PART=full to send the whole string). (3) Paste TCG_BEARER_TOKEN=… from portal if different.`
        )
      }
      if (res.status === 403) {
        console.warn(
          `[tcg] HTTP 403 on ${path}. Check TCG_ACCOUNT_ID matches the account this API key belongs to (or remove TCG_ACCOUNT_ID if not using admin-style ?account_id=).`
        )
      }
      if (res.status >= 500) {
        console.error(`[tcg] HTTP ${res.status} on ${path}:`, err)
      }
      return { ok: false, status: res.status, error: err, bodyText: lastText }
    }

    try {
      const data = (text ? JSON.parse(text) : {}) as T
      return { ok: true, status: res.status, data }
    } catch {
      return { ok: false, status: res.status, error: 'Invalid JSON from ShipLogic', bodyText: lastText }
    }
  }

  return { ok: false, status: lastStatus, error: 'Too many retries (429)', bodyText: lastText }
}
