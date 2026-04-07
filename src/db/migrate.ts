import 'dotenv/config'
import fs from 'fs/promises'
import path from 'path'
import { pool } from './client'

async function migrate() {
  const schemaPath = path.resolve(process.cwd(), 'src', 'db', 'schema.sql')
  const schemaSql = await fs.readFile(schemaPath, 'utf8')
  await pool.query(schemaSql)
  console.log('Database schema applied successfully.')
}

migrate()
  .catch((error) => {
    console.error('Migration failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
