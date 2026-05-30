import 'dotenv/config'
import { pool } from '../dist/db/client.js'

const stats = await pool.query(`
  SELECT
    COUNT(*)::int AS products,
    COUNT(*) FILTER (WHERE length_cm IS NOT NULL)::int AS with_dims,
    COUNT(*) FILTER (WHERE locker_tier IS NOT NULL)::int AS with_tier
  FROM products
`)
const tiers = await pool.query(`
  SELECT locker_tier, COUNT(*)::int AS n
  FROM products
  GROUP BY locker_tier
  ORDER BY n DESC
`)
const sample = await pool.query(`
  SELECT p.handle, p.title, p.length_cm, p.width_cm, p.height_cm, p.weight_kg, p.locker_tier,
         v.title AS variant_title, v.packaging, v.length_cm AS v_len, v.width_cm AS v_w, v.height_cm AS v_h, v.weight_kg AS v_wt, v.locker_tier AS v_tier
  FROM products p
  LEFT JOIN product_variants v ON v.product_id = p.id
  ORDER BY p.updated_at DESC NULLS LAST
  LIMIT 12
`)
console.log(JSON.stringify({ stats: stats.rows[0], tiers: tiers.rows, sample: sample.rows }, null, 2))
await pool.end()
