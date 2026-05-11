/**
 * Backend integration tests for the unified-batch model's ship/arrived/cancel/transfer
 * endpoints (Checkpoint 5.4 — playbook §17).
 *
 * Endpoints under test (all in routes/batches.ts):
 *   POST /api/batches/:id/ship
 *   POST /api/batches/:id/shipments/:shipmentId/arrived
 *   POST /api/batches/:id/shipments/:shipmentId/cancel
 *   POST /api/batches/:id/transfer
 *
 * Locked decisions exercised:
 *   §17  Multiple shipments per batch allowed
 *   §22  Freezing resets cookDate; thaw resets too (default §1)
 *   §27  Auto-cap to available qty + toast warning
 *   §28  Mark arrived: full shipment qty arrives as-is
 *   §29  Pack-accumulate: same-destination pending shipment accumulates
 *   §30  Cancel returns qty to source inventory entry
 *   §38  Arrival merge rule: same (storage, cookDate) merges; else append
 */

try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;
const { prisma } = require('../lib/db');

const T = 'test-ship-' + Date.now() + '-';
let nextId = 0;
const tid = (suffix: string) => `${T}${suffix}-${++nextId}`;

interface BatchPayload {
  id: string;
  name: string;
  type: 'Soup' | 'Main course' | 'Dessert';
  serving?: number;
  cookDate?: string | null;
  inventory?: Array<{ loc: string; storage: string; qty: number; cookDate: string }>;
  shipments?: Array<unknown>;
  services?: Array<unknown>;
  recipeId?: string | null;
  allergens?: string[];
  extraAllergens?: string[];
  note?: string;
  cookNotes?: string;
  actualIngredients?: unknown;
  orderFor?: boolean;
  stockDeducted?: boolean;
  createdAt?: string;
}

async function createBatch(overrides: Partial<BatchPayload> & { name?: string } = {}): Promise<BatchPayload> {
  const id = tid('b');
  const payload: BatchPayload = {
    id,
    name: overrides.name || 'Tomato Soup',
    type: 'Soup',
    serving: 280,
    cookDate: '01/05/2026',
    inventory: [{ loc: 'west', storage: 'Gastro', qty: 50, cookDate: '01/05/2026' }],
    shipments: [],
    services: [],
    ...overrides,
  };
  const res = await request(app).post('/api/batches').send(payload);
  expect(res.status).toBe(201);
  return res.body;
}

afterAll(async () => {
  await prisma.batch.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.$disconnect();
});

// ── POST /api/batches/:id/ship ────────────────────────────────────────────

describe('POST /api/batches/:id/ship', () => {
  it('creates a pending shipment and reduces source inventory by qty', async () => {
    const b = await createBatch();
    const res = await request(app)
      .post(`/api/batches/${b.id}/ship`)
      .send({ toLoc: 'centraal', qty: 25 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.batch.shipments).toHaveLength(1);
    expect(res.body.batch.shipments[0].qty).toBe(25);
    expect(res.body.batch.shipments[0].toLoc).toBe('centraal');
    expect(res.body.batch.shipments[0].fromLoc).toBe('west');
    expect(res.body.batch.shipments[0].arrived).toBe(false);
    expect(res.body.batch.shipments[0].cookDate).toBe('01/05/2026');
    // Source inventory entry decremented (not pruned even at non-zero remainder).
    expect(res.body.batch.inventory).toHaveLength(1);
    expect(res.body.batch.inventory[0].qty).toBe(25);
    expect(res.body.warning).toBeUndefined();
  });

  it('defaults shipment storage to the source entry storage', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Frozen', qty: 30, cookDate: '01/05/2026' }],
    });
    const res = await request(app)
      .post(`/api/batches/${b.id}/ship`)
      .send({ toLoc: 'centraal', qty: 10 });
    expect(res.status).toBe(200);
    expect(res.body.batch.shipments[0].storage).toBe('Frozen');
  });

  it('accepts explicit storage when provided (must match source storage)', async () => {
    const b = await createBatch({
      inventory: [
        { loc: 'west', storage: 'Gastro', qty: 30, cookDate: '01/05/2026' },
        { loc: 'west', storage: 'Frozen', qty: 20, cookDate: '01/05/2026' },
      ],
    });
    const res = await request(app)
      .post(`/api/batches/${b.id}/ship`)
      .send({ toLoc: 'centraal', qty: 5, storage: 'Frozen' });
    expect(res.status).toBe(200);
    expect(res.body.batch.shipments[0].storage).toBe('Frozen');
    // Frozen entry decremented, Gastro untouched.
    const frozen = res.body.batch.inventory.find((e: any) => e.storage === 'Frozen');
    expect(frozen.qty).toBe(15);
    const gastro = res.body.batch.inventory.find((e: any) => e.storage === 'Gastro');
    expect(gastro.qty).toBe(30);
  });

  it('auto-caps to available qty and returns a warning (locked §27)', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 10, cookDate: '01/05/2026' }],
    });
    const res = await request(app)
      .post(`/api/batches/${b.id}/ship`)
      .send({ toLoc: 'centraal', qty: 50 });
    expect(res.status).toBe(200);
    expect(res.body.batch.shipments[0].qty).toBe(10);
    expect(res.body.batch.inventory[0].qty).toBe(0); // zero-qty entry kept (§31)
    expect(res.body.warning).toMatch(/capped/i);
  });

  it('pack-accumulates a second send that matches dest+storage+cookDate (locked §29)', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 50, cookDate: '01/05/2026' }],
    });
    await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: 'centraal', qty: 10 });
    const second = await request(app)
      .post(`/api/batches/${b.id}/ship`)
      .send({ toLoc: 'centraal', qty: 7 });
    expect(second.status).toBe(200);
    // Still ONE shipment, qty = 10 + 7. Not two rows.
    expect(second.body.batch.shipments).toHaveLength(1);
    expect(second.body.batch.shipments[0].qty).toBe(17);
  });

  it('does NOT pack-accumulate after the first shipment has arrived', async () => {
    const b = await createBatch();
    const ship1 = await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: 'centraal', qty: 10 });
    const sId = ship1.body.batch.shipments[0].id;
    await request(app).post(`/api/batches/${b.id}/shipments/${sId}/arrived`).send({});

    const ship2 = await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: 'centraal', qty: 5 });
    // Two shipment rows now: one arrived, one pending.
    expect(ship2.body.batch.shipments).toHaveLength(2);
    expect(ship2.body.batch.shipments.filter((s: any) => !s.arrived)).toHaveLength(1);
  });

  it('rejects invalid toLoc', async () => {
    const b = await createBatch();
    const res = await request(app)
      .post(`/api/batches/${b.id}/ship`)
      .send({ toLoc: 'mars', qty: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid toLoc/);
  });

  it('rejects qty <= 0', async () => {
    const b = await createBatch();
    const res = await request(app)
      .post(`/api/batches/${b.id}/ship`)
      .send({ toLoc: 'centraal', qty: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid qty/);
  });

  it('returns 400 when no source entry can satisfy the request', async () => {
    // Inventory only at centraal — can't ship to centraal from itself.
    const b = await createBatch({
      inventory: [{ loc: 'centraal', storage: 'Gastro', qty: 30, cookDate: '01/05/2026' }],
    });
    const res = await request(app)
      .post(`/api/batches/${b.id}/ship`)
      .send({ toLoc: 'centraal', qty: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no source/i);
  });

  it('returns 404 for unknown batch id', async () => {
    const res = await request(app)
      .post('/api/batches/nonexistent/ship')
      .send({ toLoc: 'centraal', qty: 5 });
    expect(res.status).toBe(404);
  });
});

// ── POST /api/batches/:id/shipments/:shipmentId/arrived ───────────────────

describe('POST /api/batches/:id/shipments/:shipmentId/arrived', () => {
  it('flips arrived=true and merges qty into destination inventory (same storage+cookDate appends as new entry)', async () => {
    // Source has Gastro 01/05; arriving at centraal where centraal has no
    // matching entry yet — should append.
    const b = await createBatch();
    const ship = await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: 'centraal', qty: 25 });
    const sId = ship.body.batch.shipments[0].id;

    const res = await request(app).post(`/api/batches/${b.id}/shipments/${sId}/arrived`).send({});
    expect(res.status).toBe(200);
    const arrived = res.body.batch.shipments.find((s: any) => s.id === sId);
    expect(arrived.arrived).toBe(true);
    expect(arrived.arrivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // New centraal Gastro 01/05 entry appears in inventory.
    const inv = res.body.batch.inventory;
    const centraalEntry = inv.find((e: any) => e.loc === 'centraal' && e.storage === 'Gastro' && e.cookDate === '01/05/2026');
    expect(centraalEntry).toBeTruthy();
    expect(centraalEntry.qty).toBe(25);
  });

  it('merges into an existing destination entry on (storage, cookDate) match (locked §38)', async () => {
    // Pre-seed centraal Gastro 01/05 with 8L; arrival of 25L should merge -> 33L.
    const b = await createBatch({
      inventory: [
        { loc: 'west', storage: 'Gastro', qty: 50, cookDate: '01/05/2026' },
        { loc: 'centraal', storage: 'Gastro', qty: 8, cookDate: '01/05/2026' },
      ],
    });
    const ship = await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: 'centraal', qty: 25 });
    const sId = ship.body.batch.shipments[0].id;
    const res = await request(app).post(`/api/batches/${b.id}/shipments/${sId}/arrived`).send({});

    const centraalGastroEntries = res.body.batch.inventory.filter(
      (e: any) => e.loc === 'centraal' && e.storage === 'Gastro' && e.cookDate === '01/05/2026',
    );
    expect(centraalGastroEntries).toHaveLength(1);
    expect(centraalGastroEntries[0].qty).toBe(33);
  });

  it('returns 404 for unknown shipment id', async () => {
    const b = await createBatch();
    const res = await request(app)
      .post(`/api/batches/${b.id}/shipments/no-such/arrived`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('returns 404 when shipment is already arrived (no double-arrive)', async () => {
    const b = await createBatch();
    const ship = await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: 'centraal', qty: 10 });
    const sId = ship.body.batch.shipments[0].id;
    await request(app).post(`/api/batches/${b.id}/shipments/${sId}/arrived`).send({});
    const second = await request(app).post(`/api/batches/${b.id}/shipments/${sId}/arrived`).send({});
    expect(second.status).toBe(404);
  });
});

// ── POST /api/batches/:id/shipments/:shipmentId/cancel ────────────────────

describe('POST /api/batches/:id/shipments/:shipmentId/cancel', () => {
  it('returns qty to the source inventory entry and removes the shipment', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 50, cookDate: '01/05/2026' }],
    });
    const ship = await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: 'centraal', qty: 25 });
    const sId = ship.body.batch.shipments[0].id;
    expect(ship.body.batch.inventory[0].qty).toBe(25); // sanity: source decremented

    const res = await request(app).post(`/api/batches/${b.id}/shipments/${sId}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(res.body.batch.shipments).toHaveLength(0);
    // Source entry topped back up to original 50.
    const westGastro = res.body.batch.inventory.find(
      (e: any) => e.loc === 'west' && e.storage === 'Gastro' && e.cookDate === '01/05/2026',
    );
    expect(westGastro.qty).toBe(50);
  });

  it('returns 404 when shipment has already arrived (cannot cancel)', async () => {
    const b = await createBatch();
    const ship = await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: 'centraal', qty: 10 });
    const sId = ship.body.batch.shipments[0].id;
    await request(app).post(`/api/batches/${b.id}/shipments/${sId}/arrived`).send({});
    const res = await request(app).post(`/api/batches/${b.id}/shipments/${sId}/cancel`).send({});
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown shipment id', async () => {
    const b = await createBatch();
    const res = await request(app).post(`/api/batches/${b.id}/shipments/no-such/cancel`).send({});
    expect(res.status).toBe(404);
  });
});

// ── POST /api/batches/:id/transfer ────────────────────────────────────────

describe('POST /api/batches/:id/transfer', () => {
  it('moves qty between two same-batch inventory entries', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 30, cookDate: '01/05/2026' }],
    });
    const res = await request(app)
      .post(`/api/batches/${b.id}/transfer`)
      .send({ fromLoc: 'west', fromStorage: 'Gastro', toLoc: 'centraal', toStorage: 'Gastro', qty: 10 });
    expect(res.status).toBe(200);
    const west = res.body.batch.inventory.find((e: any) => e.loc === 'west');
    const centraal = res.body.batch.inventory.find((e: any) => e.loc === 'centraal');
    expect(west.qty).toBe(20);
    expect(centraal.qty).toBe(10);
  });

  it('Gastro → Frozen at same loc resets cookDate to today (locked §22)', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 30, cookDate: '01/01/2026' }],
    });
    const res = await request(app)
      .post(`/api/batches/${b.id}/transfer`)
      .send({ fromLoc: 'west', fromStorage: 'Gastro', toLoc: 'west', toStorage: 'Frozen', qty: 20 });
    expect(res.status).toBe(200);
    const frozen = res.body.batch.inventory.find((e: any) => e.storage === 'Frozen');
    expect(frozen.qty).toBe(20);
    // Today's date in DD/MM/YYYY — not the original 01/01/2026.
    expect(frozen.cookDate).not.toBe('01/01/2026');
    expect(frozen.cookDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('Frozen → Gastro resets cookDate to today (thawed shelf-life starts today, default §1)', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Frozen', qty: 20, cookDate: '01/01/2026' }],
    });
    const res = await request(app)
      .post(`/api/batches/${b.id}/transfer`)
      .send({ fromLoc: 'west', fromStorage: 'Frozen', toLoc: 'west', toStorage: 'Gastro', qty: 5 });
    expect(res.status).toBe(200);
    const gastro = res.body.batch.inventory.find((e: any) => e.storage === 'Gastro');
    expect(gastro.cookDate).not.toBe('01/01/2026');
    expect(gastro.cookDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('Gastro → Vac-packed (cross-storage non-freeze) carries source cookDate', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 30, cookDate: '01/05/2026' }],
    });
    const res = await request(app)
      .post(`/api/batches/${b.id}/transfer`)
      .send({ fromLoc: 'west', fromStorage: 'Gastro', toLoc: 'west', toStorage: 'Vac-packed', qty: 10 });
    expect(res.status).toBe(200);
    const vp = res.body.batch.inventory.find((e: any) => e.storage === 'Vac-packed');
    expect(vp.cookDate).toBe('01/05/2026');
  });

  it('rejects identical from/to (nothing to transfer)', async () => {
    const b = await createBatch();
    const res = await request(app)
      .post(`/api/batches/${b.id}/transfer`)
      .send({ fromLoc: 'west', fromStorage: 'Gastro', toLoc: 'west', toStorage: 'Gastro', qty: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/identical/i);
  });

  it('returns 400 when source inventory entry doesn\'t exist', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 30, cookDate: '01/05/2026' }],
    });
    const res = await request(app)
      .post(`/api/batches/${b.id}/transfer`)
      .send({ fromLoc: 'centraal', fromStorage: 'Gastro', toLoc: 'west', toStorage: 'Frozen', qty: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no source/i);
  });

  it('auto-caps qty to source available and returns a warning', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 8, cookDate: '01/05/2026' }],
    });
    const res = await request(app)
      .post(`/api/batches/${b.id}/transfer`)
      .send({ fromLoc: 'west', fromStorage: 'Gastro', toLoc: 'west', toStorage: 'Frozen', qty: 50 });
    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/capped/i);
    const frozen = res.body.batch.inventory.find((e: any) => e.storage === 'Frozen');
    expect(frozen.qty).toBe(8);
  });

  it('rejects invalid storage', async () => {
    const b = await createBatch();
    const res = await request(app)
      .post(`/api/batches/${b.id}/transfer`)
      .send({ fromLoc: 'west', fromStorage: 'NotAStorage', toLoc: 'centraal', toStorage: 'Gastro', qty: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid fromStorage/i);
  });
});

// ── End-to-end: ship → arrive → re-ship → cancel ──────────────────────────

describe('full lifecycle: ship → arrive → re-ship → cancel', () => {
  it('matches the cook-day flow described in the plan §22 verification', async () => {
    const b = await createBatch({
      inventory: [{ loc: 'west', storage: 'Gastro', qty: 80, cookDate: '01/05/2026' }],
    });

    // 8am send: 25L to Centraal.
    const ship1 = await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: 'centraal', qty: 25 });
    expect(ship1.body.batch.inventory.find((e: any) => e.loc === 'west').qty).toBe(55);
    const sId1 = ship1.body.batch.shipments[0].id;

    // 25L arrives.
    const arr1 = await request(app).post(`/api/batches/${b.id}/shipments/${sId1}/arrived`).send({});
    expect(arr1.body.batch.inventory.find((e: any) => e.loc === 'centraal').qty).toBe(25);

    // 1pm send: another 10L. Pack-accumulate doesn't apply here — first
    // shipment is arrived, so this becomes a new pending row.
    const ship2 = await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: 'centraal', qty: 10 });
    const pending = ship2.body.batch.shipments.find((s: any) => !s.arrived);
    expect(pending.qty).toBe(10);
    expect(ship2.body.batch.inventory.find((e: any) => e.loc === 'west').qty).toBe(45);

    // Cancel the 1pm shipment — qty returns to West Gastro 01/05.
    const cancel = await request(app).post(`/api/batches/${b.id}/shipments/${pending.id}/cancel`).send({});
    expect(cancel.body.batch.shipments.filter((s: any) => !s.arrived)).toHaveLength(0);
    expect(cancel.body.batch.inventory.find((e: any) => e.loc === 'west').qty).toBe(55);
  });
});
