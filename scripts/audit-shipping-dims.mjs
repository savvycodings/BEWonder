import 'dotenv/config'
import { pool } from '../dist/db/client.js'

const r = await pool.query(`
  SELECT
    COUNT(*)::int AS total_products,
    COUNT(*) FILTER (WHERE length_cm IS NULL)::int AS null_dims,
    COUNT(*) FILTER (WHERE length_cm = 60 AND width_cm = 17 AND height_cm = 8 AND weight_kg = 2)::int AS default_single,
    COUNT(*) FILTER (WHERE length_cm = 60 AND width_cm = 41 AND height_cm = 17 AND weight_kg = 5)::int AS default_set
  FROM products
`)
// variants
const v = await pool.query(`
  SELECT
    COUNT(*)::int AS total_variants,
    COUNT(*) FILTER (WHERE length_cm IS NULL)::int AS null_dims,
    COUNT(*) FILTER (WHERE packaging = 'single')::int AS singles,
    COUNT(*) FILTER (WHERE packaging = 'set')::int AS sets,
    COUNT(*) FILTER (WHERE packaging = 'standard')::int AS standard
  FROM product_variants
`)

const distinct = await pool.query(`
  SELECT length_cm, width_cm, height_cm, weight_kg, COUNT(*)::int AS n
  FROM product_variants
  WHERE length_cm IS NOT NULL
  GROUP BY 1,2,3,4
  ORDER BY n DESC
  LIMIT 10
`)

const nullSample = await pool.query(`
  SELECT p.handle, p.title
  FROM products p
  WHERE p.length_cm IS NULL
  LIMIT 8
`)

const mismatch = await pool.query(`
  SELECT p.handle, v.title AS variant_title, v.packaging,
         p.length_cm AS p_len, v.length_cm AS v_len,
         p.locker_tier AS p_tier, v.locker_tier AS v_tier
  FROM product_variants v
  JOIN products p ON p.id = v.product_id
  WHERE v.packaging = 'single' AND v.length_cm = 60 AND v.width_cm = 41
  LIMIT 5
`)

console.log(JSON.stringify({
  products: r.rows[0],
  variants: v.rows[0],
  distinctCombos: distinct.rows,
  nullSample: nullSample.rows,
  productVariantMismatches: mismatch.rows,
}, null, 2))

await pool.end()
