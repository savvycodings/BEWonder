import 'dotenv/config'
import { Pool, QueryResultRow } from 'pg'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL iss required to connect to Neon Postgres')
}

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false,
  },
})

export async function runQuery<T extends QueryResultRow = QueryResultRow>(
  query: string,
  values: any[] = []
) {
  return pool.query<T>(query, values)
}
