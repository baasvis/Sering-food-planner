#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/snapshot-db.js — capture a pg_dump backup of the database.
// ─────────────────────────────────────────────────────────────────────────────
//
// Required before applying the unified-batch-inventory data-migrate at deploy
// time so we can roll back if the collapse goes wrong. See
// prisma/migrations/DEPLOY.md for the full sequence.
//
// LIMITATION: this script only takes the dump. A real rollback test requires
// MANUALLY restoring the .sql into a scratch DB and running the app against it.
// Don't deploy assuming this snapshot is valid until you've round-tripped at
// least once.
//
// USAGE:
//   node scripts/snapshot-db.js --db <url> --out <path>
//   node scripts/snapshot-db.js                # uses DATABASE_URL, writes
//                                              # ./snapshot-<YYYYMMDD-HHMMSS>.sql
//
// REQUIRES `pg_dump` on PATH (Postgres client tools, version compatible with
// the server — for Railway Postgres 15, use pg_dump 15+).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const { values: args } = parseArgs({
  options: {
    db: { type: 'string' },
    out: { type: 'string' },
  },
  allowPositionals: false,
});

const dbUrl = args.db ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('ERROR: no DB url. Pass --db <url> or set DATABASE_URL.');
  process.exit(1);
}

function timestampedFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `snapshot-${ts}.sql`;
}

const outPath = path.resolve(args.out ?? timestampedFilename());

// Don't log the full URL (creds!) — just host/db.
const dbDisplay = (() => {
  try {
    const u = new URL(dbUrl);
    return `${u.host}${u.pathname}`;
  } catch { return '<unparseable>'; }
})();

console.log(`pg_dump → ${outPath}`);
console.log(`  source: ${dbDisplay}`);

const dumpResult = spawnSync('pg_dump', [
  '--no-owner',     // strip OWNER lines so dump can restore to a different account
  '--no-acl',       // strip GRANT/REVOKE so dump can restore to a different account
  '--format=plain', // text SQL — inspectable with head/grep, applied with psql
  '--schema=public',// skip pg_* / Railway-housekeeping schemas
  `--file=${outPath}`,
  dbUrl,
], { stdio: ['ignore', 'inherit', 'inherit'] });

if (dumpResult.error) {
  console.error(`ERROR: failed to spawn pg_dump: ${dumpResult.error.message}`);
  if (dumpResult.error.code === 'ENOENT') {
    console.error('  Is `pg_dump` on PATH? Install Postgres client tools (`postgresql` package on most distros, `brew install libpq` on macOS, https://www.postgresql.org/download/ on Windows).');
  }
  process.exit(1);
}
if (dumpResult.status !== 0) {
  console.error(`ERROR: pg_dump exited with status ${dumpResult.status}`);
  process.exit(dumpResult.status ?? 1);
}

// ── Sanity check the dump ──────────────────────────────────────────────────
let stats;
try {
  stats = fs.statSync(outPath);
} catch (e) {
  console.error(`ERROR: pg_dump claimed success but ${outPath} is missing: ${e.message}`);
  process.exit(1);
}
const sizeMb = (stats.size / 1024 / 1024).toFixed(2);
console.log(`  size: ${sizeMb} MB`);

// Skim first 200 lines for CREATE TABLE markers — if zero, the dump is suspect.
const head = fs.readFileSync(outPath, { encoding: 'utf8', flag: 'r' }).split('\n').slice(0, 500);
const createTableCount = head.filter(l => /^CREATE TABLE/i.test(l)).length;
const copyFromCount = head.filter(l => /^COPY .* FROM stdin/i.test(l)).length;
console.log(`  sanity: ${createTableCount} CREATE TABLE / ${copyFromCount} COPY FROM in first 500 lines`);
if (createTableCount === 0) {
  console.error('WARNING: no CREATE TABLE statements found in first 500 lines. Dump may be empty or malformed — inspect manually.');
}

console.log('');
console.log('Snapshot captured. NEXT STEP: round-trip test against a scratch DB before relying on this for rollback:');
console.log(`  createdb scratch_restore_test`);
console.log(`  psql scratch_restore_test < ${outPath}`);
console.log(`  # then run the app against scratch_restore_test and confirm it boots`);
