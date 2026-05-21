#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED-BATCH-INVENTORY DATA MIGRATE (Task B)
// ─────────────────────────────────────────────────────────────────────────────
//
// Sibling of migration.sql in this same folder. Run AFTER the add_cols
// migration applies, BEFORE the drop_cols migration. Collapses parent/split
// batch families into one canonical row per family with `inventory[]` +
// `shipments[]` populated from the legacy columns.
//
// Audit items addressed:
//   S6  — catering ref dedup (the "two peers = half demand" bug)
//   S13 — catering ref rewrite covers both deleted-children AND
//         deleted-parent → canonical id
//   S15 — cycle-safe family walk (mirrors public/js/core.ts:36-50)
//
// USAGE:
//   tsx prisma/migrations/.../data-migrate.ts --dry-run
//     - reads, computes, prints summary, exits 0; no DB writes
//   tsx prisma/migrations/.../data-migrate.ts
//     - same but commits the transaction
//   --db <url>   override DATABASE_URL_TEST (preferred) or DATABASE_URL
//   --allow-prod required to bypass the prod-host safety guard
//   --verbose    print every per-family decision (not just first 3 / anomalies)
//
// SAFETY:
//   - Refuses to run against PROD_HOST_FRAGMENTS unless --allow-prod is set.
//   - Single transaction (BEGIN/COMMIT) — partial-state crash is impossible.
//   - Idempotent: per-batch guard checks if inventory[] is already populated;
//     skips that batch. A clean re-run after success is a no-op.
//
// SEE ALSO: prisma/migrations/DEPLOY.md for the 5-step deploy sequence.

import { PrismaClient, Prisma } from '@prisma/client';
import { parseArgs } from 'node:util';
import crypto from 'node:crypto';

// ── Args ─────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'db': { type: 'string' },
    'allow-prod': { type: 'boolean', default: false },
    'verbose': { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const DRY_RUN = !!args['dry-run'];
const VERBOSE = !!args['verbose'];
const ALLOW_PROD = !!args['allow-prod'];

// Prefer explicit --db, then DATABASE_URL_TEST (staging), then DATABASE_URL.
const dbUrl = (args.db as string | undefined) ?? process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('ERROR: no DB url. Pass --db <url>, or set DATABASE_URL_TEST or DATABASE_URL.');
  process.exit(1);
}

// Mirror test/setup-env.ts PROD_HOST_FRAGMENTS so we never accidentally write
// to prod without the explicit --allow-prod opt-in.
const PROD_HOST_FRAGMENTS = ['centerbeam.proxy.rlwy.net'];
const looksLikeProd = (url: string) => PROD_HOST_FRAGMENTS.some(f => url.includes(f));
if (looksLikeProd(dbUrl) && !ALLOW_PROD) {
  console.error('ERROR: --db looks like a production host. Pass --allow-prod to bypass this guard.');
  console.error(`  matched: ${PROD_HOST_FRAGMENTS.find(f => dbUrl.includes(f))}`);
  process.exit(1);
}

// ── Types (only what we read from the DB) ───────────────────────────────────

type Loc = 'west' | 'centraal';
type Storage = 'Gastro' | 'Frozen' | 'Vac-packed';

interface InventoryEntry { loc: Loc; storage: Storage; qty: number; cookDate: string }
interface Shipment {
  id: string; fromLoc: Loc; toLoc: Loc; storage: Storage; qty: number;
  sentAt: string; arrived: boolean; arrivedAt?: string; cookDate: string;
}
interface ServiceRow { loc: Loc; date: string; meal: 'lunch' | 'dinner' }
interface CateringDish { dishId: string; name: string; type: string }

interface BatchRow {
  id: string;
  name: string;
  type: string;
  // legacy cols
  stock: number;
  storage: string;
  location: string;
  inTransit: boolean;
  parentId: string | null;
  cookDate: string | null;
  // shared
  allergens: string[];
  extraAllergens: string[];
  note: string;
  services: ServiceRow[] | unknown;
  createdAt: string;
  // new cols (may be empty arrays for unmigrated rows)
  inventory: InventoryEntry[] | unknown;
  shipments: Shipment[] | unknown;
}

interface CateringRow { id: string; dishes: CateringDish[] | unknown }

// ── Date / value normalisation (mirrors lib/db.ts mapBatchRow fallback) ─────

const DDMMYYYY_PATTERN = /^\d{2}\/\d{2}\/\d{4}$/;
const DDMMYYYY_DASH_PATTERN = /^(\d{2})-(\d{2})-(\d{4})$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function todayDdMmYyyy(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function normCookDate(raw: string | null | undefined, fallback?: string): string {
  if (raw && DDMMYYYY_PATTERN.test(raw)) return raw;
  const dashMatch = raw?.match(DDMMYYYY_DASH_PATTERN);
  if (dashMatch) return `${dashMatch[1]}/${dashMatch[2]}/${dashMatch[3]}`;
  if (fallback && DDMMYYYY_PATTERN.test(fallback)) return fallback;
  const fbDash = fallback?.match(DDMMYYYY_DASH_PATTERN);
  if (fbDash) return `${fbDash[1]}/${fbDash[2]}/${fbDash[3]}`;
  return todayDdMmYyyy();
}

function normIsoTimestamp(raw: string | null | undefined): string {
  if (raw && ISO_TIMESTAMP_PATTERN.test(raw)) return raw;
  if (raw) {
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

// ── Family walk (cycle-safe; mirrors public/js/core.ts:36-50, audit S15) ────

interface RootResult { rootId: string; cycleDetected: boolean }

function getRootId(b: BatchRow, byId: Map<string, BatchRow>): RootResult {
  const visited = new Set<string>();
  let cur = b;
  while (cur.parentId && !visited.has(cur.id)) {
    visited.add(cur.id);
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    cur = parent;
  }
  if (cur.parentId && visited.has(cur.id)) {
    const sorted = [...visited, cur.id].sort();
    return { rootId: sorted[0], cycleDetected: true };
  }
  return { rootId: cur.id, cycleDetected: false };
}

// ── Anomaly tracking ────────────────────────────────────────────────────────

interface CycleWarning { rootId: string; visitedIds: string[] }
interface BigFamilyNotice { rootId: string; size: number; memberIds: string[] }
interface CateringDivergence {
  cateringId: string;
  canonicalDishId: string;
  divergent: { name?: string[]; type?: string[] };
}

const cycleWarnings: CycleWarning[] = [];
const bigFamilyNotices: BigFamilyNotice[] = [];
const cateringDivergences: CateringDivergence[] = [];

// ── Per-family transformer ──────────────────────────────────────────────────

interface FamilyDecision {
  rootId: string;
  canonicalId: string;
  members: BatchRow[];
  inventory: InventoryEntry[];
  shipments: Shipment[];
  services: ServiceRow[];
  allergens: string[];
  extraAllergens: string[];
  note: string;
  childIdsToDelete: string[];
}

// Consolidate within-batch by (loc, storage, cookDate) so two
// same-cookDate-and-storage entries from two members collapse into one.
// Mirrors mergeIntoInventory() in routes/batches.ts so the post-migrate
// shape matches what /ship + /transfer + /shipments/.../arrived produce.
function consolidateInventory(inv: InventoryEntry[]): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  for (const entry of inv) {
    const idx = out.findIndex(e =>
      e.loc === entry.loc && e.storage === entry.storage && e.cookDate === entry.cookDate,
    );
    if (idx >= 0) out[idx] = { ...out[idx], qty: out[idx].qty + entry.qty };
    else out.push(entry);
  }
  return out;
}

function buildFamilyDecision(family: BatchRow[]): FamilyDecision {
  // Sort by createdAt ASC; oldest is canonical (root if root is in the family,
  // else oldest surviving member).
  const sorted = [...family].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const familyIds = new Set(sorted.map(m => m.id));
  const { rootId } = getRootId(sorted[0], new Map(sorted.map(m => [m.id, m])));
  const canonicalId = familyIds.has(rootId) ? rootId : sorted[0].id;
  const canonical = sorted.find(m => m.id === canonicalId)!;

  const inventory: InventoryEntry[] = [];
  const shipments: Shipment[] = [];
  const servicesSeen = new Set<string>();
  const services: ServiceRow[] = [];
  const allergensSet = new Set<string>();
  const extraAllergensSet = new Set<string>();
  const noteParts: string[] = [];

  for (const m of sorted) {
    const cookDate = normCookDate(m.cookDate, canonical.cookDate ?? undefined);

    // Skip zero-stock entries — they contribute nothing. A fully-spent
    // family ends up with `inventory: []`, which is correct (no food =
    // empty inventory) and matches mapBatchRow's transitional fallback,
    // whose `stock > 0` guard keeps it from re-synthesizing on read.
    if (!m.inTransit && m.stock > 0) {
      inventory.push({
        loc: m.location as Loc,
        storage: m.storage as Storage,
        qty: m.stock,
        cookDate,
      });
    }

    // Shipments: in-transit member with positive stock = pending shipment.
    // fromLoc is "the opposite side" since locations are binary west↔centraal.
    if (m.inTransit && m.stock > 0) {
      const fromLoc: Loc = m.location === 'west' ? 'centraal' : 'west';
      shipments.push({
        id: crypto.randomUUID(),
        fromLoc,
        toLoc: m.location as Loc,
        storage: m.storage as Storage,
        qty: m.stock,
        sentAt: normIsoTimestamp(m.createdAt),
        arrived: false,
        cookDate,
      });
    }

    // Services union (dedup by loc-date-meal key).
    const svcArr = Array.isArray(m.services) ? (m.services as ServiceRow[]) : [];
    for (const svc of svcArr) {
      const key = `${svc.loc}-${svc.date}-${svc.meal}`;
      if (!servicesSeen.has(key)) {
        servicesSeen.add(key);
        services.push(svc);
      }
    }

    for (const a of (m.allergens || [])) allergensSet.add(a);
    for (const a of (m.extraAllergens || [])) extraAllergensSet.add(a);
    if (m.note && m.note.trim()) noteParts.push(m.note);
  }

  return {
    rootId,
    canonicalId,
    members: sorted,
    inventory: consolidateInventory(inventory),
    shipments,
    services,
    allergens: [...allergensSet].sort(),
    extraAllergens: [...extraAllergensSet].sort(),
    note: noteParts.join('\n'),
    childIdsToDelete: sorted.filter(m => m.id !== canonicalId).map(m => m.id),
  };
}

// ── Catering rewrite + dedup (audit S6, S13) ────────────────────────────────
//
// Edge case worth flagging for future maintainers: if a catering is created
// AFTER a successful data-migrate run but references a `dishId` of a
// previously-deleted child row (impossible via the UI today since the picker
// only offers live batches, but theoretically possible via a stale client
// or direct API write), a re-run of this migrate won't fix it — the
// deleted child id is no longer in `byId`/`canonicalIdMap`. The catering
// row would carry a permanent dangling ref. Defensible: the UI shouldn't
// expose deleted ids, and the ref just renders as "Unknown dish" rather
// than crashing.

interface CateringWrite { id: string; dishes: CateringDish[] }

function rewriteAndDedupCaterings(
  caterings: CateringRow[],
  canonicalIdMap: Map<string, string>,
): { writes: CateringWrite[]; rewriteCount: number; dedupCount: number } {
  const writes: CateringWrite[] = [];
  let rewriteCount = 0;
  let dedupCount = 0;

  for (const cat of caterings) {
    const dishes = (Array.isArray(cat.dishes) ? cat.dishes : []) as CateringDish[];
    let modified = false;

    // Step 1: rewrite ANY dishId pointing at a deleted-child OR
    // canonical-of-deleted-parent → canonical id (audit S13).
    const rewritten: CateringDish[] = dishes.map(d => {
      const canonical = canonicalIdMap.get(d.dishId);
      if (canonical && canonical !== d.dishId) {
        modified = true;
        rewriteCount++;
        return { ...d, dishId: canonical };
      }
      return d;
    });

    // Step 2: dedup by canonical dishId (audit S6 — the "two peers" fix).
    // Keep first occurrence; flag any name/type divergence as anomaly.
    const seen = new Map<string, CateringDish>();
    const deduped: CateringDish[] = [];
    for (const d of rewritten) {
      const prev = seen.get(d.dishId);
      if (prev) {
        dedupCount++;
        modified = true;
        const divergent: { name?: string[]; type?: string[] } = {};
        if (prev.name !== d.name) divergent.name = [prev.name, d.name];
        if (prev.type !== d.type) divergent.type = [prev.type, d.type];
        if (divergent.name || divergent.type) {
          cateringDivergences.push({
            cateringId: cat.id, canonicalDishId: d.dishId, divergent,
          });
        }
        continue;
      }
      seen.set(d.dishId, d);
      deduped.push(d);
    }

    if (modified) writes.push({ id: cat.id, dishes: deduped });
  }

  return { writes, rewriteCount, dedupCount };
}

// ── Idempotency: detect already-migrated rows ───────────────────────────────

function batchNeedsMigrate(b: BatchRow): boolean {
  const inv = Array.isArray(b.inventory) ? (b.inventory as InventoryEntry[]) : [];
  const ship = Array.isArray(b.shipments) ? (b.shipments as Shipment[]) : [];
  const hasNewShape = inv.length > 0 || ship.length > 0;
  const hasOldData = (b.stock > 0 || b.inTransit) && !!b.location && !!b.storage;
  return hasOldData && !hasNewShape;
}

// ── Pretty-print helpers ────────────────────────────────────────────────────

function formatMember(m: BatchRow): string {
  const txn = m.inTransit ? 'inTransit' : '!inTransit';
  return `${m.id} [${m.location}, ${m.storage}, ${m.stock}L, cookDate ${m.cookDate ?? '<null>'}, ${txn}]`;
}

function formatFamilyDecision(fd: FamilyDecision): string {
  const lines: string[] = [];
  const canonicalRow = fd.members.find(m => m.id === fd.canonicalId)!;
  lines.push(`  --- Family root ${fd.rootId} (${canonicalRow.name}, ${fd.members.length} member${fd.members.length === 1 ? '' : 's'})`);
  lines.push(`      canonical: ${fd.canonicalId} (${fd.canonicalId === fd.rootId ? 'root' : 'oldest survivor — root missing'}, oldest createdAt)`);
  for (const m of fd.members) {
    const role = m.id === fd.canonicalId ? '[canonical]' : '[child]';
    let target = '';
    if (m.stock <= 0) target = '→ skipped (zero stock)';
    else if (m.inTransit) target = '→ SHIPMENT (new uuid will be assigned)';
    else target = '→ inventory entry';
    lines.push(`      ${role} ${formatMember(m)} ${target}`);
  }
  const invSummary = fd.inventory.length === 0 ? '<empty>' : fd.inventory.map(e => `${e.loc}/${e.storage}:${e.qty}L`).join(', ');
  const shipSummary = fd.shipments.length === 0 ? '<none>' : fd.shipments.map(s => `${s.toLoc}/${s.storage}:${s.qty}L pending`).join(', ');
  lines.push(`      result: inventory[${fd.inventory.length}] = ${invSummary}; shipments[${fd.shipments.length}] = ${shipSummary}`);
  lines.push(`      services unioned: ${fd.services.length} unique slots; allergens unioned: ${fd.allergens.length}`);
  if (fd.childIdsToDelete.length > 0) lines.push(`      will delete child rows: ${fd.childIdsToDelete.join(', ')}`);
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  console.log(`=== unified-batch-inventory data-migrate (${DRY_RUN ? 'DRY RUN' : 'WRITE MODE'}) ===`);
  // Don't log the full URL (creds!) — just the host:port/db part.
  const dbDisplay = (() => {
    try {
      const u = new URL(dbUrl);
      return `${u.host}${u.pathname}`;
    } catch { return '<unparseable>'; }
  })();
  console.log(`DB: ${dbDisplay}`);

  // Read everything. Single SELECT each — these are < 2k rows in prod.
  // If `inventory`/`shipments` cols don't exist, Prisma raw will error
  // explicitly — that's the "ran before add_cols migration" trap.
  let batchRows: BatchRow[];
  let cateringRows: CateringRow[];
  try {
    batchRows = await prisma.$queryRawUnsafe<BatchRow[]>(`
      SELECT id, name, type, stock, serving, storage, location,
             in_transit AS "inTransit",
             allergens, extra_allergens AS "extraAllergens",
             order_for AS "orderFor",
             cook_date AS "cookDate",
             parent_id AS "parentId",
             note, services,
             created_at AS "createdAt",
             recipe_id AS "recipeId",
             actual_ingredients AS "actualIngredients",
             cook_notes AS "cookNotes",
             stock_deducted AS "stockDeducted",
             generated,
             inventory, shipments
      FROM batches
      ORDER BY created_at ASC
    `);
    cateringRows = await prisma.$queryRawUnsafe<CateringRow[]>(`SELECT id, dishes FROM caterings`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('inventory') || msg.includes('shipments') || msg.includes('does not exist')) {
      console.error('ERROR: required columns are missing from `batches`. Run `npx prisma migrate deploy` first to apply add_cols.');
      console.error(`  underlying: ${msg}`);
      await prisma.$disconnect();
      process.exit(1);
    }
    throw e;
  }

  console.log(`Read: ${batchRows.length} batches, ${cateringRows.length} caterings`);

  // ── Build family map ─────────────────────────────────────────────────────
  const byId = new Map(batchRows.map(b => [b.id, b]));
  const familyByRoot = new Map<string, BatchRow[]>();
  for (const b of batchRows) {
    const { rootId, cycleDetected } = getRootId(b, byId);
    if (cycleDetected) {
      // Collect IDs touched in cycle (pseudo-recompute). For cycle detection
      // we just need to record the symptom — the rootId is deterministic.
      const visited = new Set<string>();
      let cur: BatchRow | undefined = b;
      while (cur && cur.parentId && !visited.has(cur.id)) {
        visited.add(cur.id);
        cur = byId.get(cur.parentId);
      }
      if (!cycleWarnings.find(w => w.rootId === rootId)) {
        cycleWarnings.push({ rootId, visitedIds: [...visited].sort() });
      }
    }
    if (!familyByRoot.has(rootId)) familyByRoot.set(rootId, []);
    familyByRoot.get(rootId)!.push(b);
  }

  for (const [rootId, family] of familyByRoot) {
    if (family.length > 5) {
      bigFamilyNotices.push({ rootId, size: family.length, memberIds: family.map(m => m.id).sort() });
    }
  }

  const totalFamilies = familyByRoot.size;
  const singleMember = [...familyByRoot.values()].filter(f => f.length === 1).length;
  const multiMember = totalFamilies - singleMember;
  const largestFamily = Math.max(0, ...[...familyByRoot.values()].map(f => f.length));
  const pctSingle = totalFamilies === 0 ? 0 : Math.round((singleMember / totalFamilies) * 1000) / 10;

  console.log(``);
  console.log(`Family analysis:`);
  console.log(`  Total families: ${totalFamilies}`);
  console.log(`  Single-member families (no parent/child relation): ${singleMember} (${pctSingle}%)`);
  console.log(`  Multi-member families: ${multiMember}`);
  console.log(`  Largest family size: ${largestFamily} member${largestFamily === 1 ? '' : 's'}`);
  console.log(`  Cycle warnings: ${cycleWarnings.length}`);
  console.log(`  Big-family notices (>5 members): ${bigFamilyNotices.length}`);

  // ── Idempotency check ────────────────────────────────────────────────────
  const needsMigrateRows = batchRows.filter(batchNeedsMigrate);
  const alreadyMigratedRows = batchRows.filter(b => {
    const inv = Array.isArray(b.inventory) ? (b.inventory as InventoryEntry[]) : [];
    const ship = Array.isArray(b.shipments) ? (b.shipments as Shipment[]) : [];
    return inv.length > 0 || ship.length > 0;
  });
  if (needsMigrateRows.length === 0 && alreadyMigratedRows.length === batchRows.length) {
    console.log(``);
    console.log(`Already migrated — every batch with old-shape data is also in new shape. No-op.`);
    await prisma.$disconnect();
    return;
  }
  if (alreadyMigratedRows.length > 0) {
    console.log(``);
    console.log(`Partial state detected: ${alreadyMigratedRows.length} batches already migrated, ${needsMigrateRows.length} still need migration.`);
    console.log(`  Will skip already-migrated rows; will process the remainder.`);
  }

  // ── Compute family decisions ─────────────────────────────────────────────
  // Build decisions for EVERY family up front (one pass, cached). The
  // canonicalIdMap then covers spent + already-collapsed families too, so
  // catering refs to those resolve. The "to-process" subset is derived from
  // the full set by filtering against needs-migrate rows.
  const decisionByRoot = new Map<string, FamilyDecision>();
  for (const [rootId, family] of familyByRoot) {
    decisionByRoot.set(rootId, buildFamilyDecision(family));
  }

  const familiesToProcess = new Set<string>();
  for (const r of needsMigrateRows) {
    const { rootId } = getRootId(r, byId);
    familiesToProcess.add(rootId);
  }
  const decisions: FamilyDecision[] = [];
  for (const rootId of familiesToProcess) {
    decisions.push(decisionByRoot.get(rootId)!);
  }

  // canonicalIdMap covers EVERY family so catering refs to fully-zero /
  // already-collapsed families also resolve to the right canonical id.
  const canonicalIdMap = new Map<string, string>();
  for (const [rootId, decision] of decisionByRoot) {
    for (const m of familyByRoot.get(rootId)!) {
      canonicalIdMap.set(m.id, decision.canonicalId);
    }
  }
  const { writes: cateringWrites, rewriteCount, dedupCount } = rewriteAndDedupCaterings(cateringRows, canonicalIdMap);

  // ── Print decisions (first 3 multi-member, then any anomaly families) ──
  console.log(``);
  console.log(`Per-family decisions (showing first 3 multi-member, then any anomaly families${VERBOSE ? ' [VERBOSE: showing all]' : ''}):`);
  const multiDecisions = decisions.filter(d => d.members.length > 1);
  const anomalyRoots = new Set([...cycleWarnings.map(w => w.rootId), ...bigFamilyNotices.map(n => n.rootId)]);
  const sample = VERBOSE
    ? decisions
    : [
        ...multiDecisions.slice(0, 3),
        ...decisions.filter(d => anomalyRoots.has(d.rootId) && !multiDecisions.slice(0, 3).find(s => s.rootId === d.rootId)),
      ];
  if (sample.length === 0) {
    console.log(`  (no multi-member families to show; all needs-migrate batches are single-member)`);
  } else {
    for (const fd of sample) console.log(formatFamilyDecision(fd));
  }
  if (!VERBOSE && decisions.length > sample.length) {
    console.log(`  ... and ${decisions.length - sample.length} more familie${decisions.length - sample.length === 1 ? '' : 's'} (re-run with --verbose for full list)`);
  }

  // ── Catering summary ─────────────────────────────────────────────────────
  console.log(``);
  console.log(`Catering ref rewrites:`);
  console.log(`  Total catering rows scanned: ${cateringRows.length}`);
  console.log(`  Catering rows to be written: ${cateringWrites.length}`);
  console.log(`  Total dishId rewrites: ${rewriteCount}`);
  console.log(`  Catering entries deduped (S6 fix): ${dedupCount}`);
  console.log(`  Name/type divergences on dedup: ${cateringDivergences.length}`);

  // ── Write summary ────────────────────────────────────────────────────────
  const totalBatchUpdates = decisions.length;
  const totalBatchDeletes = decisions.reduce((s, d) => s + d.childIdsToDelete.length, 0);
  console.log(``);
  console.log(`Proposed writes (${DRY_RUN ? 'DRY RUN — NOT executing' : 'will execute below'}):`);
  console.log(`  - ${totalBatchUpdates} batch updates (write inventory + shipments JSON, plus union'd services/allergens/note)`);
  console.log(`  - ${totalBatchDeletes} batch deletes (children to be removed)`);
  console.log(`  - ${cateringWrites.length} catering updates (rewritten + deduped dishes)`);
  if (!DRY_RUN) {
    console.log(`  - 1 activity-log row (system / migration / unified-batch-collapse)`);
  }

  // ── Anomalies ────────────────────────────────────────────────────────────
  console.log(``);
  if (cycleWarnings.length === 0 && bigFamilyNotices.length === 0 && cateringDivergences.length === 0) {
    console.log(`Anomalies: (none)`);
  } else {
    console.log(`Anomalies:`);
    if (cycleWarnings.length > 0) {
      console.log(`  cycleWarnings: ${cycleWarnings.length}`);
      console.log(`    ${JSON.stringify(cycleWarnings, null, 2).split('\n').join('\n    ')}`);
    }
    if (bigFamilyNotices.length > 0) {
      console.log(`  bigFamilyNotices: ${bigFamilyNotices.length}`);
      console.log(`    ${JSON.stringify(bigFamilyNotices, null, 2).split('\n').join('\n    ')}`);
    }
    if (cateringDivergences.length > 0) {
      console.log(`  cateringDivergences: ${cateringDivergences.length}`);
      console.log(`    ${JSON.stringify(cateringDivergences, null, 2).split('\n').join('\n    ')}`);
    }
  }

  // ── Write phase ──────────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log(``);
    console.log(`(dry-run: nothing committed)`);
    await prisma.$disconnect();
    return;
  }

  console.log(``);
  console.log(`Beginning write transaction...`);
  await prisma.$transaction(async (tx) => {
    // 1. Update canonical batches
    for (const fd of decisions) {
      await tx.$executeRawUnsafe(
        `UPDATE batches
            SET inventory = $1::jsonb,
                shipments = $2::jsonb,
                services  = $3::jsonb,
                allergens = $4,
                extra_allergens = $5,
                note = $6
          WHERE id = $7`,
        JSON.stringify(fd.inventory),
        JSON.stringify(fd.shipments),
        JSON.stringify(fd.services),
        fd.allergens,
        fd.extraAllergens,
        fd.note,
        fd.canonicalId,
      );
    }

    // 2. Delete child rows (after canonical update so catering refs survive
    //    the FK chain). Step 3 then rewrites those orphan refs.
    const allChildIds = decisions.flatMap(d => d.childIdsToDelete);
    if (allChildIds.length > 0) {
      // Generate a $1, $2, $3, ... placeholder string for the IN clause
      const placeholders = allChildIds.map((_, i) => `$${i + 1}`).join(',');
      await tx.$executeRawUnsafe(
        `DELETE FROM batches WHERE id IN (${placeholders})`,
        ...allChildIds,
      );
    }

    // 3. Catering writes (rewritten + deduped)
    for (const cw of cateringWrites) {
      await tx.$executeRawUnsafe(
        `UPDATE caterings SET dishes = $1::jsonb WHERE id = $2`,
        JSON.stringify(cw.dishes),
        cw.id,
      );
    }

    // 4. Single activity-log row
    const details = `Migrated ${decisions.length} families (${totalBatchUpdates} canonicals updated, ${totalBatchDeletes} children deleted), ${cateringWrites.length} caterings (${rewriteCount} refs rewritten, ${dedupCount} entries deduped)`;
    await tx.$executeRawUnsafe(
      `INSERT INTO log (timestamp, email, name, action, details) VALUES ($1, $2, $3, $4, $5)`,
      new Date().toISOString(),
      'system',
      'migration',
      'unified-batch-collapse',
      details,
    );
  }, {
    // Default tx timeout is 5s; per-batch sequential UPDATEs across ~1000
    // prod families plus catering rewrites can plausibly exceed that on
    // Railway's EU→Postgres latency. 60s is generous for a one-shot
    // migration. maxWait padded for the same reason — no concurrency
    // contention here, but cheap insurance.
    timeout: 60_000,
    maxWait: 10_000,
  });

  console.log(`Done. Transaction committed.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
