/* eslint-disable */
/**
 * seed-staging.js — Copy domain data from production to staging.
 *
 * Reads from PROD_DATABASE_URL, writes to STAGING_DATABASE_URL.
 * Truncates each table on staging before inserting, so it's idempotent.
 *
 * Tables copied (FK-safe order):
 *   ingredients → recipes → recipe_ingredients → recipe_photos →
 *   batches → guests → guests_next_weeks →
 *   guest_history → guest_history_meta → caterings → transport_items →
 *   standard_inventory → storage_config → prep_checklist
 *
 * Tables intentionally SKIPPED:
 *   telemetry_event, ai_insight, feedback, log, daily_revenue,
 *   product_revenue, recipe_index (legacy), cook_schedule (prod-only)
 *
 * Usage:
 *   PROD_DATABASE_URL=... STAGING_DATABASE_URL=... node scripts/seed-staging.js
 */
const { Client } = require('pg');

const PROD = process.env.PROD_DATABASE_URL;
const STAGING = process.env.STAGING_DATABASE_URL;
if (!PROD || !STAGING) {
  console.error('Set PROD_DATABASE_URL and STAGING_DATABASE_URL env vars');
  process.exit(1);
}
// Safety check: refuse to run if the "staging" URL points at a prod-like host
if (STAGING.includes('centerbeam.proxy.rlwy.net')) {
  console.error('STAGING_DATABASE_URL looks like production host — aborting');
  process.exit(1);
}

// Tables in dependency order (parents before children).
const COPY_ORDER = [
  'ingredients',
  'recipes',
  'recipe_ingredients',
  'recipe_photos',
  'batches',
  'guests',
  'guests_next_weeks',
  'guest_history',
  'guest_history_meta',
  'caterings',
  'transport_items',
  'standard_inventory',
  'storage_config',
  'prep_checklist',
];

function quoteIdent(s) {
  return '"' + s.replace(/"/g, '""') + '"';
}

async function getColumnInfo(client, table) {
  const r = await client.query(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const map = new Map();
  for (const row of r.rows) {
    map.set(row.column_name, { dataType: row.data_type, udtName: row.udt_name });
  }
  return map;
}

async function copyTable(prod, staging, table) {
  // Intersect prod and staging columns to tolerate schema drift (prod has
  // columns added via `prisma db push` that aren't in staging's migrations).
  const prodColInfo = await getColumnInfo(prod, table);
  const stagingColInfo = await getColumnInfo(staging, table);
  const prodCols = new Set(prodColInfo.keys());
  const stagingCols = new Set(stagingColInfo.keys());
  const columns = [...prodCols].filter(c => stagingCols.has(c));
  const colTypes = columns.map(c => stagingColInfo.get(c));
  const dropped = [...prodCols].filter(c => !stagingCols.has(c));
  if (dropped.length > 0) {
    console.log(`  ${table}: skipping prod-only columns: ${dropped.join(', ')}`);
  }
  if (columns.length === 0) {
    console.log(`  ${table}: no shared columns (skipped)`);
    return;
  }
  const selectList = columns.map(quoteIdent).join(', ');
  const res = await prod.query(`SELECT ${selectList} FROM ${quoteIdent(table)}`);
  const rows = res.rows;
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows (skipped)`);
    return;
  }
  const colList = selectList;

  // Insert in chunks of 200 to avoid huge single statements
  const orderedRows = rows;
  const CHUNK = 200;
  let inserted = 0;
  for (let i = 0; i < orderedRows.length; i += CHUNK) {
    const chunk = orderedRows.slice(i, i + CHUNK);
    const params = [];
    const placeholders = chunk.map((row, rowIdx) => {
      const rowParams = columns.map((col, colIdx) => {
        const paramIdx = rowIdx * columns.length + colIdx + 1;
        let val = row[col];
        const info = colTypes[colIdx];
        const isJson = info && (info.dataType === 'json' || info.dataType === 'jsonb');
        const isArrayCol = info && info.dataType === 'ARRAY';
        // For json/jsonb columns: serialize objects/arrays to JSON strings.
        // For text[]/ARRAY columns: leave JS arrays alone — pg driver handles them.
        // For other columns with object values (shouldn't happen normally): stringify.
        if (isJson && val !== null && typeof val === 'object' && !(val instanceof Date) && !Buffer.isBuffer(val)) {
          val = JSON.stringify(val);
        } else if (!isArrayCol && !isJson && val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date) && !Buffer.isBuffer(val)) {
          val = JSON.stringify(val);
        }
        params.push(val);
        return '$' + paramIdx;
      });
      return '(' + rowParams.join(', ') + ')';
    }).join(', ');

    const sql = `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES ${placeholders}`;
    await staging.query(sql, params);
    inserted += chunk.length;
  }
  console.log(`  ${table}: ${inserted} rows copied`);
}

(async () => {
  const prod = new Client(PROD);
  const staging = new Client(STAGING);
  await prod.connect();
  await staging.connect();
  console.log('Connected to both databases');

  // Schema probe: confirm prod is on the unified-batch schema. If the
  // `inventory` column is missing, this DB is pre-migration — abort before
  // we try to copy columns that no longer exist on staging.
  const probe = await prod.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'batches' AND column_name = 'inventory'`,
  );
  if (probe.rows.length === 0) {
    console.error('ERROR: prod database does not have the unified-batch schema. Run the migration first (see prisma/migrations/DEPLOY.md). Aborting.');
    console.error('Schema probe: SELECT column_name FROM information_schema.columns WHERE table_name=batches AND column_name=inventory returned 0 rows — prod has not been migrated yet.');
    process.exit(1);
  }

  // Verify we're hitting a staging-like host on the write side
  const stagingCheck = await staging.query('SELECT inet_server_addr() AS addr, current_database() AS db');
  console.log('Staging server:', stagingCheck.rows[0]);

  console.log('\nTruncating staging tables (reverse order)...');
  // Reverse order to handle FK dependencies
  for (const t of [...COPY_ORDER].reverse()) {
    await staging.query(`TRUNCATE TABLE ${quoteIdent(t)} RESTART IDENTITY CASCADE`);
  }
  console.log('  done');

  console.log('\nCopying tables...');
  for (const t of COPY_ORDER) {
    await copyTable(prod, staging, t);
  }

  console.log('\nVerifying row counts...');
  for (const t of COPY_ORDER) {
    const p = await prod.query(`SELECT COUNT(*)::int AS c FROM ${quoteIdent(t)}`);
    const s = await staging.query(`SELECT COUNT(*)::int AS c FROM ${quoteIdent(t)}`);
    const match = p.rows[0].c === s.rows[0].c ? '✓' : '✗';
    console.log(`  ${match} ${t.padEnd(25)} prod=${p.rows[0].c}  staging=${s.rows[0].c}`);
  }

  await prod.end();
  await staging.end();
  console.log('\nDone.');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
