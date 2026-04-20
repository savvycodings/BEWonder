import crypto from 'crypto'
import { runQuery } from '../db/client'

const ALPHANUM = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz'

/** Human-readable order reference, e.g. WP-K4mN9pQ2 (include in EFT reference field). */
export function randomReferenceSuffix(len = 8): string {
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) {
    out += ALPHANUM[bytes[i]! % ALPHANUM.length]
  }
  return out
}

export async function generateUniqueReferenceCode(): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = `WP-${randomReferenceSuffix(8)}`
    const dup = await runQuery<{ c: string }>(
      `SELECT 1 as c FROM orders WHERE reference_code = $1 LIMIT 1`,
      [code]
    )
    if (!dup.rows.length) return code
  }
  throw new Error('Could not allocate unique reference_code')
}
