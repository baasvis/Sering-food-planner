/**
 * End-to-end tests for the unified-batch data migration script
 * (`prisma/migrations/20260511120000_unified_batch_inventory_add_cols/data-migrate.ts`)
 * — Checkpoint 5.4 playbook §17.
 *
 * Strategy: insert raw legacy-shape rows via SQL (legacy `stock`/`location`/
 * `storage`/`in_transit`/`parent_id` cols still exist on the test DB — drop_cols
 * is a separate later migration), spawn the script as a subprocess against the
 * test DB, then read back and assert.
 *
 * Audit items exercised:
 *   S6  — catering ref dedup (the "two peers = half demand" bug)
 *   S13 — catering ref rewrite covers deleted-children → canonical id
 *   S15 — cycle-safe family walk (parent.parentId = child.id)
 *
 * Locked decisions exercised:
 *   §15  Stock shape: full inventory list `[{loc, storage, qty, cookDate}]`
 *   §31  Zero-qty entries handling (skipped at migration; preserved in-app)
 *   §38  Same (loc, storage, cookDate) merges
 */

try { require('dotenv').config(); } catch (_e) {}
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const { prisma } = require('../lib/db');

const SCRIPT_PATH = path.resolve(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260511120000_unified_batch_inventory_add_cols',
  'data-migrate.ts',
);

const T = 'test-mig-' + Date.now() + '-';
let nextSeq = 0;
const tid = (label: string) => `${T}${label}-${++nextSeq}`;

// Each test in this file spawns `npx tsx data-migrate.ts` as a child process
// against the test DB (Railway staging proxy in normal local use). On Windows,
// `npx tsx` cold-starts in 2–4s and the DB RTT adds another 1–3s on top of
// Jest's default 5s per-test timeout — that's the edge that fluked three tests
// on a real machine even though the same suite ran ~25s green on a Linux
// sandbox. 60s gives every spawn comfortable headroom; pure test-only setting
// with zero impact on production code.
jest.setTimeout(60_000);

function runMigrate(extraArgs: string[] = []): { stdout: string; stderr: string; status: number } {
  // shell: true is REQUIRED for Windows. Without it, spawnSync('npx', ...)
  // tries to exec a file literally named "npx" which doesn't exist —
  // Windows has npx.cmd. The shell wrapper resolves PATHEXT for us on
  // Windows and is a harmless pass-through on POSIX. Caught on Windows
  // verification of b8d526d.
  const r = spawnSync('npx', ['tsx', SCRIPT_PATH, ...extraArgs], {
    env: {
      ...process.env,
      DATABASE_URL_TEST: process.env.DATABASE_URL_TEST!,
      DATABASE_URL: process.env.DATABASE_URL_TEST!,
    },
    encoding: 'utf-8',
    shell: true,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status ?? -1 };
}

interface LegacyBatchRow {
  id: string;
  name?: string;
  type?: 'Soup' | 'Main course' | 'Dessert';
  stock?: number;
  storage?: 'Gastro' | 'Frozen' | 'Vac-packed';
  location?: 'west' | 'centraal';
  inTransit?: boolean;
  parentId?: string | null;
  cookDate?: string | null;
  services?: Array<{ loc: string; date: string; meal: string }>;
  allergens?: string[];
  extraAllergens?: string[];
  note?: string;
  createdAt?: string;
}

async function insertLegacyBatch(row: LegacyBatchRow): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO batches
       (id, name, type, stock, serving, storage, location, in_transit,
        allergens, extra_allergens, order_for, cook_date, parent_id, note,
        services, created_at, cook_notes, stock_deducted, generated, inventory, shipments)
     VALUES ($1, $2, $3, $4, 280, $5, $6, $7, $8, $9, false, $10, $11, $12,
             $13::jsonb, $14, '', false, false, '[]'::jsonb, '[]'::jsonb)`,
    row.id,
    row.name ?? 'Test Batch',
    row.type ?? 'Soup',
    row.stock ?? 0,
    row.storage ?? 'Gastro',
    row.location ?? 'west',
    row.inTransit ?? false,
    row.allergens ?? [],
    row.extraAllergens ?? [],
    row.cookDate ?? null,
    row.parentId ?? null,
    row.note ?? '',
    JSON.stringify(row.services ?? []),
    row.createdAt ?? new Date().toISOString(),
  );
}

interface LegacyCateringRow {
  id: string;
  dishes: Array<{ dishId: string; name: string; type: string }>;
}

async function insertLegacyCatering(row: LegacyCateringRow): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO caterings (id, name, date, guest_count, delivery_mode, dishes, logistics_notes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    row.id,
    `Catering ${row.id}`,
    null,
    20,
    'pickup',
    JSON.stringify(row.dishes),
    '',
    new Date().toISOString(),
  );
}

interface BatchSnapshot {
  id: string;
  inventory: Array<{ loc: string; storage: string; qty: number; cookDate: string }>;
  shipments: Array<{ id: string; fromLoc: string; toLoc: string; storage: string; qty: number; arrived: boolean; cookDate: string }>;
  services: Array<{ loc: string; date: string; meal: string }>;
  allergens: string[];
  parentId: string | null;
}

async function readBatch(id: string): Promise<BatchSnapshot | null> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, inventory, shipments, services, allergens, parent_id AS "parentId" FROM batches WHERE id = $1`,
    id,
  );
  return rows[0] ?? null;
}

async function readCateringDishes(id: string): Promise<Array<{ dishId: string; name: string; type: string }>> {
  const rows: any[] = await prisma.$queryRawUnsafe(`SELECT dishes FROM caterings WHERE id = $1`, id);
  return rows[0]?.dishes ?? [];
}

async function clearTestRows(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM caterings WHERE id LIKE $1`, `${T}%`);
  // Children first (FK ON DELETE SET NULL keeps order safe, but we want a clean slate).
  await prisma.$executeRawUnsafe(`DELETE FROM batches WHERE id LIKE $1`, `${T}%`);
}

beforeEach(async () => {
  await clearTestRows();
});

afterAll(async () => {
  await clearTestRows();
  await prisma.$disconnect();
});

// ── Single-batch migration (no parent/split) ─────────────────────────────

describe('data-migrate: single batch (no parent/split)', () => {
  it('populates inventory[] from legacy stock/location/storage/cookDate', async () => {
    const id = tid('lonely');
    await insertLegacyBatch({
      id, name: 'Lonely Soup',
      stock: 30, location: 'west', storage: 'Gastro', cookDate: '01/05/2026',
    });

    const r = runMigrate();
    expect(r.status).toBe(0);

    const after = await readBatch(id);
    expect(after).toBeTruthy();
    expect(after!.inventory).toHaveLength(1);
    expect(after!.inventory[0]).toMatchObject({
      loc: 'west', storage: 'Gastro', qty: 30, cookDate: '01/05/2026',
    });
    expect(after!.shipments).toHaveLength(0);
  });

  it('skips zero-stock batches (inventory stays empty)', async () => {
    const id = tid('spent');
    await insertLegacyBatch({
      id, name: 'Spent Soup', stock: 0, location: 'west', cookDate: '01/05/2026',
    });

    const r = runMigrate();
    expect(r.status).toBe(0);
    const after = await readBatch(id);
    expect(after!.inventory).toHaveLength(0);
  });
});

// ── Parent + split family collapse ───────────────────────────────────────

describe('data-migrate: parent + split family collapse', () => {
  it('collapses parent + split at DIFFERENT locs into two inventory entries on the canonical row', async () => {
    const parentId = tid('parent');
    const splitId = tid('split');
    await insertLegacyBatch({
      id: parentId, name: 'Tomato Soup',
      stock: 50, location: 'west', storage: 'Gastro', cookDate: '01/05/2026',
      createdAt: '2026-05-01T08:00:00Z',
    });
    await insertLegacyBatch({
      id: splitId, name: 'Tomato Soup (split)',
      stock: 25, location: 'centraal', storage: 'Gastro', cookDate: '01/05/2026',
      parentId,
      createdAt: '2026-05-01T08:30:00Z',
    });

    const r = runMigrate();
    expect(r.status).toBe(0);

    // Parent (= canonical, oldest createdAt) survives with both entries.
    const canonical = await readBatch(parentId);
    expect(canonical).toBeTruthy();
    expect(canonical!.inventory).toHaveLength(2);
    const west = canonical!.inventory.find(e => e.loc === 'west');
    const centraal = canonical!.inventory.find(e => e.loc === 'centraal');
    expect(west).toMatchObject({ qty: 50, storage: 'Gastro', cookDate: '01/05/2026' });
    expect(centraal).toMatchObject({ qty: 25, storage: 'Gastro', cookDate: '01/05/2026' });

    // Child row deleted.
    const child = await readBatch(splitId);
    expect(child).toBeNull();
  });

  it('merges parent + split SAME loc + same cookDate into one entry (consolidate)', async () => {
    // Two same-loc same-cookDate members get folded by consolidateInventory.
    const parentId = tid('p');
    const splitId = tid('s');
    await insertLegacyBatch({
      id: parentId, name: 'Soup', stock: 40, location: 'west',
      storage: 'Gastro', cookDate: '01/05/2026',
      createdAt: '2026-05-01T08:00:00Z',
    });
    await insertLegacyBatch({
      id: splitId, name: 'Soup (split)', stock: 10, location: 'west',
      storage: 'Gastro', cookDate: '01/05/2026', parentId,
      createdAt: '2026-05-01T09:00:00Z',
    });

    const r = runMigrate();
    expect(r.status).toBe(0);
    const canonical = await readBatch(parentId);
    expect(canonical!.inventory).toHaveLength(1);
    expect(canonical!.inventory[0].qty).toBe(50);
  });

  it('treats an in-transit split as a pending shipment (qty + fromLoc=opposite)', async () => {
    const parentId = tid('p');
    const splitId = tid('s');
    await insertLegacyBatch({
      id: parentId, name: 'Pea Soup',
      stock: 60, location: 'west', storage: 'Gastro', cookDate: '02/05/2026',
      createdAt: '2026-05-02T08:00:00Z',
    });
    await insertLegacyBatch({
      id: splitId, name: 'Pea Soup (split)',
      stock: 20, location: 'centraal', storage: 'Gastro', cookDate: '02/05/2026',
      parentId, inTransit: true,
      createdAt: '2026-05-02T08:30:00Z',
    });

    const r = runMigrate();
    expect(r.status).toBe(0);

    const canonical = await readBatch(parentId);
    expect(canonical!.shipments).toHaveLength(1);
    expect(canonical!.shipments[0]).toMatchObject({
      qty: 20, toLoc: 'centraal', fromLoc: 'west', storage: 'Gastro',
      arrived: false, cookDate: '02/05/2026',
    });
    // The in-transit split's qty is in shipments[], NOT in inventory[].
    expect(canonical!.inventory.find(e => e.loc === 'centraal')).toBeUndefined();
  });

  it('unions services from parent + child (deduped by loc-date-meal key)', async () => {
    const parentId = tid('p');
    const splitId = tid('s');
    await insertLegacyBatch({
      id: parentId, name: 'Soup',
      stock: 40, location: 'west', cookDate: '01/05/2026',
      services: [
        { loc: 'west', date: '2026-05-01', meal: 'lunch' },
        { loc: 'centraal', date: '2026-05-01', meal: 'dinner' },
      ],
      createdAt: '2026-05-01T08:00:00Z',
    });
    await insertLegacyBatch({
      id: splitId, name: 'Soup (split)',
      stock: 10, location: 'centraal', cookDate: '01/05/2026', parentId,
      services: [
        { loc: 'centraal', date: '2026-05-01', meal: 'dinner' }, // dup
        { loc: 'centraal', date: '2026-05-02', meal: 'lunch' },
      ],
      createdAt: '2026-05-01T09:00:00Z',
    });

    const r = runMigrate();
    expect(r.status).toBe(0);
    const canonical = await readBatch(parentId);
    expect(canonical!.services).toHaveLength(3); // 4 inputs, 1 dup → 3 unique
  });
});

// ── Catering ref rewrite + dedup (S6, S13) ───────────────────────────────

describe('data-migrate: catering ref rewrite + dedup', () => {
  it('rewrites a dishId pointing at a deleted child → canonical id (audit S13)', async () => {
    const parentId = tid('p');
    const splitId = tid('s');
    const cateringId = tid('cat');
    await insertLegacyBatch({
      id: parentId, name: 'Soup', stock: 40, location: 'west',
      cookDate: '01/05/2026', createdAt: '2026-05-01T08:00:00Z',
    });
    await insertLegacyBatch({
      id: splitId, name: 'Soup (split)', stock: 10, location: 'centraal',
      cookDate: '01/05/2026', parentId, createdAt: '2026-05-01T09:00:00Z',
    });
    await insertLegacyCatering({
      id: cateringId,
      dishes: [{ dishId: splitId, name: 'Soup', type: 'Soup' }],
    });

    const r = runMigrate();
    expect(r.status).toBe(0);

    const dishes = await readCateringDishes(cateringId);
    expect(dishes).toHaveLength(1);
    expect(dishes[0].dishId).toBe(parentId); // rewritten to canonical
  });

  it('flags name/type divergence as an anomaly when deduping two refs (data-migrate.ts:328-335)', async () => {
    // Two catering refs to parent+split that disagree on the displayed
    // dish name (cook edited one row but not the other in the old UI).
    // After migration both rewrite to canonical id; dedup keeps the first;
    // divergence is reported as a cateringDivergence anomaly in stdout.
    const parentId = tid('p');
    const splitId = tid('s');
    const cateringId = tid('cat');
    await insertLegacyBatch({
      id: parentId, name: 'Soup', stock: 40, location: 'west',
      cookDate: '01/05/2026', createdAt: '2026-05-01T08:00:00Z',
    });
    await insertLegacyBatch({
      id: splitId, name: 'Soup (split)', stock: 10, location: 'centraal',
      cookDate: '01/05/2026', parentId, createdAt: '2026-05-01T09:00:00Z',
    });
    await insertLegacyCatering({
      id: cateringId,
      dishes: [
        { dishId: parentId, name: 'Soup',                 type: 'Soup' },
        { dishId: splitId,  name: 'Soup — kid portion', type: 'Soup' },
      ],
    });

    const r = runMigrate();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/cateringDivergences/);
    // Scoped sanity: name divergence pair shows our exact strings.
    expect(r.stdout).toMatch(/Soup — kid portion/);

    const dishes = await readCateringDishes(cateringId);
    expect(dishes).toHaveLength(1);
    expect(dishes[0].dishId).toBe(parentId);
  });

  it('dedups two refs to parent + split into one (audit S6 — "two peers" fix)', async () => {
    const parentId = tid('p');
    const splitId = tid('s');
    const cateringId = tid('cat');
    await insertLegacyBatch({
      id: parentId, name: 'Soup', stock: 40, location: 'west',
      cookDate: '01/05/2026', createdAt: '2026-05-01T08:00:00Z',
    });
    await insertLegacyBatch({
      id: splitId, name: 'Soup (split)', stock: 10, location: 'centraal',
      cookDate: '01/05/2026', parentId, createdAt: '2026-05-01T09:00:00Z',
    });
    await insertLegacyCatering({
      id: cateringId,
      dishes: [
        { dishId: parentId, name: 'Soup', type: 'Soup' },
        { dishId: splitId, name: 'Soup', type: 'Soup' },
      ],
    });

    const r = runMigrate();
    expect(r.status).toBe(0);

    const dishes = await readCateringDishes(cateringId);
    expect(dishes).toHaveLength(1); // deduped
    expect(dishes[0].dishId).toBe(parentId);
  });
});

// ── Cycle handling (audit S15) ───────────────────────────────────────────

describe('data-migrate: cycle handling (audit S15)', () => {
  it('survives a parent.parentId = child.id cycle without infinite loop', async () => {
    // Build a cycle: A.parentId = B, B.parentId = A. Use a NULL parentId on
    // insert then UPDATE to bypass the FK self-reference ordering trap.
    const aId = tid('a');
    const bId = tid('b');
    await insertLegacyBatch({
      id: aId, name: 'Cyclic A', stock: 20, location: 'west',
      cookDate: '01/05/2026', createdAt: '2026-05-01T08:00:00Z',
    });
    await insertLegacyBatch({
      id: bId, name: 'Cyclic B', stock: 10, location: 'centraal',
      cookDate: '01/05/2026', parentId: aId, createdAt: '2026-05-01T09:00:00Z',
    });
    // Close the cycle: A.parentId = B.
    await prisma.$executeRawUnsafe(`UPDATE batches SET parent_id = $1 WHERE id = $2`, bId, aId);

    const r = runMigrate();
    expect(r.status).toBe(0);

    // The canonical row exists with BOTH members' inventory folded in;
    // cycle was reported (not crashed). Either A or B is canonical
    // depending on cycle resolution.
    const a = await readBatch(aId);
    const b = await readBatch(bId);
    const canonical = a ?? b;
    expect(canonical).toBeTruthy();
    // Both members contributed inventory — total qty across canonical's
    // inventory[] is A's 20 + B's 10 = 30 (locked §15 + audit S15).
    const totalQty = canonical!.inventory.reduce((s, e) => s + e.qty, 0);
    expect(totalQty).toBe(30);
    // Output mentions the cycle anomaly.
    expect(r.stdout).toMatch(/cycleWarnings/);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────

describe('data-migrate: idempotency', () => {
  it('a second run does not re-mutate an already-migrated batch', async () => {
    // Asserts on OUR specific row's before/after JSON instead of grepping
    // global stdout — Jest runs test files in parallel and other suites
    // (api.test.ts, shipment-flow.test.ts) seed batches in the same DB, so
    // the script's "Already migrated" branch may not fire on a global level
    // even when it's effectively a no-op for our row.
    const id = tid('once');
    await insertLegacyBatch({
      id, name: 'Soup', stock: 30, location: 'west', cookDate: '01/05/2026',
    });

    const r1 = runMigrate();
    expect(r1.status).toBe(0);
    const after1 = await readBatch(id);
    const inv1JSON = JSON.stringify(after1!.inventory);
    const ship1JSON = JSON.stringify(after1!.shipments);
    expect(after1!.inventory).toHaveLength(1); // sanity: first run did populate

    const r2 = runMigrate();
    expect(r2.status).toBe(0);

    const after2 = await readBatch(id);
    expect(JSON.stringify(after2!.inventory)).toBe(inv1JSON);
    expect(JSON.stringify(after2!.shipments)).toBe(ship1JSON);
  });
});

// ── Dry-run safety ────────────────────────────────────────────────────────

describe('data-migrate: --dry-run', () => {
  it('writes nothing to OUR test batch when --dry-run is set', async () => {
    // Same reasoning as the idempotency test: assert on our row's state
    // rather than parsing stdout, so parallel-run pollution can't flake us.
    const id = tid('dry');
    await insertLegacyBatch({
      id, name: 'Soup', stock: 30, location: 'west', cookDate: '01/05/2026',
    });
    const before = await readBatch(id);
    expect(before!.inventory).toHaveLength(0); // baseline: not migrated

    const r = runMigrate(['--dry-run']);
    expect(r.status).toBe(0);
    // Stdout sanity check (still local to this run, not affected by parallel
    // suites — every invocation prints its own DRY RUN header).
    expect(r.stdout).toMatch(/DRY RUN|dry-run/i);

    const after = await readBatch(id);
    expect(after!.inventory).toHaveLength(0); // OUR row unchanged
    expect(after!.shipments).toHaveLength(0);
  });
});
