/**
 * Event locations — registry CRUD, lifecycle, and the KNOWN/ACTIVE validation
 * contract across the write paths.
 *
 *   - routes/event-locations.ts: director-gated CRUD + archive/unarchive,
 *     slug derivation (immutable "ev-" keys, reserved names, auto-suffix),
 *     archive guard (pending shipments block; stock/services warn).
 *   - lib/locations.ts: registry cache (KNOWN incl. archived vs ACTIVE).
 *   - lib/db.ts: validateBatch/validateGuests accept KNOWN event keys; the
 *     dbReadAll guest scaffold must round-trip ARCHIVED event-loc guest rows
 *     through writeGuests' deleteMany-createMany cycle (the data-loss trap).
 *   - routes/batches.ts: ship toLoc ACTIVE-only; transfer fromLoc KNOWN
 *     (leftover evacuation from an archived event).
 *   - routes/hanos.ts: /status per-location map.
 *
 * Director gating mirrors access-request.test.ts: dev@local is promoted via
 * DIRECTOR_EMAILS before ../app loads; restored in afterAll.
 */

const _origDirector = process.env.DIRECTOR_EMAILS;
process.env.DIRECTOR_EMAILS = 'dev@local';

try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;
const { prisma, dbLoadEventLocations, validateBatch, validateGuests } = require('../lib/db');
const { isKnownLocation, isActiveLocation } = require('../lib/locations');
const { deriveSlug } = require('../routes/event-locations');

const T = 'test-evloc-' + Date.now();
const NAME = `Zzz Evloc ${Date.now()}`; // display name; slug derives from it
let nextId = 0;
const tid = (suffix: string) => `${T}-${suffix}-${++nextId}`;

jest.setTimeout(30_000);

async function loginDirector(): Promise<string[]> {
  const res = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'] as unknown as string[];
}

async function createEventLoc(cookie: string[], over: Record<string, unknown> = {}): Promise<{ slug: string; name: string }> {
  const res = await request(app).post('/api/event-locations').set('Cookie', cookie).send({
    name: `${NAME} ${++nextId}`,
    startDate: '2026-07-20',
    endDate: '2026-07-30',
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body;
}

function fullBatch(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: 'Evloc Soup',
    type: 'Soup',
    serving: 280,
    cookDate: '01/05/2026',
    inventory: [{ loc: 'west', storage: 'Gastro', qty: 50, cookDate: '01/05/2026' }],
    shipments: [],
    services: [],
    ...over,
  };
}

afterAll(async () => {
  await prisma.batch.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.supply.deleteMany({ where: { id: { startsWith: T } } });
  // Guest rows written by the round-trip test: without this, leftover
  // "ev-zzz-evloc-*" Guest rows from a past run outlive their (deleted)
  // registry rows and surface as unknown keys in every later GET /api/data.
  await prisma.guest.deleteMany({ where: { location: { startsWith: 'ev-zzz-evloc' } } });
  // Test event locations: slugs derive from NAME ("Zzz Evloc <ts> <n>").
  await prisma.eventLocation.deleteMany({ where: { name: { startsWith: 'Zzz Evloc' } } });
  await prisma.eventLocation.deleteMany({ where: { createdBy: 'dev@local' } });
  await dbLoadEventLocations(); // leave the in-process cache clean for other suites
  if (_origDirector === undefined) delete process.env.DIRECTOR_EMAILS; else process.env.DIRECTOR_EMAILS = _origDirector;
  await prisma.$disconnect();
});

// ── Slug derivation (pure) ──────────────────────────────────────────────────

describe('deriveSlug', () => {
  it('lowercases, hyphenates, prefixes ev-', () => {
    expect(deriveSlug('Landjuweel 2026')).toBe('ev-landjuweel-2026');
  });
  it('strips diacritics and junk', () => {
    expect(deriveSlug('  Fête & Friends!  ')).toBe('ev-fete-friends');
  });
  it('never collides with permanent keys (structural ev- prefix)', () => {
    expect(deriveSlug('west')).toBe('ev-west');
    expect(deriveSlug('centraal')).toBe('ev-centraal');
  });
});

// ── CRUD + gating ───────────────────────────────────────────────────────────

describe('POST /api/event-locations', () => {
  it('403 without a director session', async () => {
    const res = await request(app).post('/api/event-locations').send({
      name: 'No Auth Fest', startDate: '2026-07-20', endDate: '2026-07-30',
    });
    expect(res.status).toBe(403);
  });

  it('creates with a derived ev- slug and defaults (hanosAccount west, active)', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    expect(created.slug.startsWith('ev-zzz-evloc')).toBe(true);
    expect(created).toMatchObject({ hanosAccount: 'west', archived: false, archivedAt: null });
    // Registry cache updated in-process:
    expect(isKnownLocation(created.slug)).toBe(true);
    expect(isActiveLocation(created.slug)).toBe(true);
  });

  it('rejects bad input: missing/long name, bad dates, endDate < startDate, bad hanosAccount', async () => {
    const cookie = await loginDirector();
    const base = { name: 'Bad Input Fest', startDate: '2026-07-20', endDate: '2026-07-30' };
    expect((await request(app).post('/api/event-locations').set('Cookie', cookie).send({ ...base, name: '' })).status).toBe(400);
    expect((await request(app).post('/api/event-locations').set('Cookie', cookie).send({ ...base, name: 'x'.repeat(61) })).status).toBe(400);
    expect((await request(app).post('/api/event-locations').set('Cookie', cookie).send({ ...base, startDate: '20-07-2026' })).status).toBe(400);
    expect((await request(app).post('/api/event-locations').set('Cookie', cookie).send({ ...base, endDate: '2026-07-19' })).status).toBe(400);
    expect((await request(app).post('/api/event-locations').set('Cookie', cookie).send({ ...base, hanosAccount: 'hanos' })).status).toBe(400);
  });

  it('auto-suffixes a duplicate name instead of failing', async () => {
    const cookie = await loginDirector();
    const name = `${NAME} dup`;
    const a = await request(app).post('/api/event-locations').set('Cookie', cookie).send({ name, startDate: '2026-07-20', endDate: '2026-07-30' });
    const b = await request(app).post('/api/event-locations').set('Cookie', cookie).send({ name, startDate: '2026-08-20', endDate: '2026-08-30' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.slug).toBe(`${a.body.slug}-2`);
  });
});

describe('GET /api/event-locations + PATCH + lifecycle', () => {
  it('lists rows; ?activeOnly=1 hides archived; unarchive restores', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);

    const arch = await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie);
    expect(arch.status).toBe(200);
    expect(arch.body.eventLocation.archived).toBe(true);
    expect(arch.body.eventLocation.archivedAt).toBeTruthy();
    expect(isKnownLocation(created.slug)).toBe(true);   // KNOWN survives archive
    expect(isActiveLocation(created.slug)).toBe(false); // ACTIVE does not

    const activeOnly = await request(app).get('/api/event-locations?activeOnly=1').set('Cookie', cookie);
    expect(activeOnly.body.some((r: { slug: string }) => r.slug === created.slug)).toBe(false);
    const all = await request(app).get('/api/event-locations').set('Cookie', cookie);
    expect(all.body.some((r: { slug: string }) => r.slug === created.slug)).toBe(true);

    const un = await request(app).post(`/api/event-locations/${created.slug}/unarchive`).set('Cookie', cookie);
    expect(un.status).toBe(200);
    expect(isActiveLocation(created.slug)).toBe(true);
  });

  it('PATCH edits name/dates/hanosAccount; slug is immutable', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    const res = await request(app).patch(`/api/event-locations/${created.slug}`).set('Cookie', cookie)
      .send({ name: `${NAME} renamed`, hanosAccount: 'centraal' });
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe(created.slug);
    expect(res.body.name).toBe(`${NAME} renamed`);
    expect(res.body.hanosAccount).toBe('centraal');
    // Date-order guard applies against merged values:
    const bad = await request(app).patch(`/api/event-locations/${created.slug}`).set('Cookie', cookie)
      .send({ endDate: '2026-01-01' });
    expect(bad.status).toBe(400);
  });

  it('archive hard-blocks while a shipment to the location is un-arrived', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    const b = fullBatch(tid('shipblock'));
    expect((await request(app).post('/api/batches').send(b)).status).toBe(201);
    const ship = await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: created.slug, qty: 10 });
    expect(ship.status).toBe(200);

    const blocked = await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/in transit/i);

    // Mark arrived → archive proceeds, with a leftover-stock warning.
    const sid = ship.body.batch.shipments[0].id;
    expect((await request(app).post(`/api/batches/${b.id}/shipments/${sid}/arrived`).send({})).status).toBe(200);
    const ok = await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.warnings.some((w: string) => w.includes('stock'))).toBe(true);
  });
});

// ── Validation contract: KNOWN vs ACTIVE ────────────────────────────────────

describe('location validation across write paths', () => {
  it('validateBatch accepts event-loc services/inventory/shipments, incl. archived slugs', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    const mk = (loc: string) => ({
      ...fullBatch('validatebatch-x'),
      inventory: [{ loc, storage: 'Gastro', qty: 5, cookDate: '01/05/2026' }],
      services: [{ loc, date: '2026-07-25', meal: 'lunch' }],
    });
    expect(validateBatch(mk(created.slug))).toBeNull();
    expect(validateBatch(mk('ev-not-a-real-loc'))).toMatch(/invalid/);
    await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie);
    expect(validateBatch(mk(created.slug))).toBeNull(); // KNOWN: history keeps validating
  });

  it('validateGuests: permanent keys required; event keys optional but must be KNOWN', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    const week = () => {
      const w: Record<string, { lunch: number; dinner: number }> = {};
      for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) w[d] = { lunch: 0, dinner: 0 };
      return w;
    };
    const base = { west: week(), centraal: week() };
    expect(validateGuests(base)).toBeNull();
    expect(validateGuests({ ...base, [created.slug]: week() })).toBeNull();
    // A KNOWN event key may be SPARSE (review fix: SSE sessions build the
    // block one edited day at a time) — but present days must be well-shaped.
    expect(validateGuests({ ...base, [created.slug]: { Mon: { lunch: 1, dinner: 1 } } })).toBeNull();
    expect(validateGuests({ ...base, [created.slug]: { Mon: { lunch: 'x', dinner: 1 } } } as never)).toMatch(/Invalid guest count/);
    // ...but an UNKNOWN key is tolerated and skipped, even with garbage shape:
    // the whole guests object round-trips on save, and a stray DB key must
    // never brick the pipeline (it just isn't written by the merge).
    expect(validateGuests({ ...base, 'ev-junk-key': week() })).toBeNull();
    expect(validateGuests({ ...base, 'ev-junk-key': 'garbage' as never })).toBeNull();
    expect(validateGuests({ west: week() })).toMatch(/centraal missing/);
  });

  it('ship toLoc: active event OK, archived event rejected', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    const b = fullBatch(tid('shiploc'));
    await request(app).post('/api/batches').send(b);
    expect((await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: created.slug, qty: 5 })).status).toBe(200);
    await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie).catch(() => null);
    // The pending shipment blocks archive — cancel it first, then archive.
    const batchRow = await prisma.batch.findUnique({ where: { id: b.id } });
    const ships = batchRow.shipments as Array<{ id: string }>;
    await request(app).post(`/api/batches/${b.id}/shipments/${ships[0].id}/cancel`).send({});
    expect((await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).post(`/api/batches/${b.id}/ship`).send({ toLoc: created.slug, qty: 5 })).status).toBe(400);
  });

  it('transfer: fromLoc may be an ARCHIVED event (leftover evacuation to West)', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    const b = fullBatch(tid('evac'), {
      inventory: [{ loc: created.slug, storage: 'Gastro', qty: 20, cookDate: '01/05/2026' }],
    });
    expect((await request(app).post('/api/batches').send(b)).status).toBe(201);
    await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie);

    const evac = await request(app).post(`/api/batches/${b.id}/transfer`).send({
      fromLoc: created.slug, fromStorage: 'Gastro', toLoc: 'west', toStorage: 'Gastro', qty: 20,
    });
    expect(evac.status).toBe(200);
    const inv = evac.body.batch.inventory as Array<{ loc: string; qty: number }>;
    expect(inv.filter(e => e.qty > 0).every(e => e.loc === 'west')).toBe(true);

    // But the archived slug is NOT a valid destination anymore:
    const back = await request(app).post(`/api/batches/${b.id}/transfer`).send({
      fromLoc: 'west', fromStorage: 'Gastro', toLoc: created.slug, toStorage: 'Gastro', qty: 5,
    });
    expect(back.status).toBe(400);
  });
});

// ── Guest round-trip: the writeGuests data-loss trap ────────────────────────

describe('event-loc guests survive archive + subsequent saves', () => {
  it('round-trips archived event-loc guest rows through a west-only save', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);

    // 1. Enter guest counts for the event location.
    const data0 = await request(app).get('/api/data').set('Cookie', cookie);
    const guests = data0.body.guests;
    expect(guests[created.slug]).toBeTruthy(); // scaffold present immediately
    guests[created.slug].Mon = { lunch: 400, dinner: 700 };
    const save1 = await request(app).post('/api/data/patch').set('Cookie', cookie)
      .send({ guests: { ...guests, [created.slug]: guests[created.slug] } });
    expect(save1.status).toBe(200);

    // 2. Verify persisted.
    const data1 = await request(app).get('/api/data').set('Cookie', cookie);
    expect(data1.body.guests[created.slug].Mon).toEqual({ lunch: 400, dinner: 700 });

    // 3. Archive, then save a WEST-only guest edit (the deleteMany/createMany cycle).
    await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie);
    const westEdit = { west: data1.body.guests.west };
    westEdit.west.Mon = { ...westEdit.west.Mon };
    const save2 = await request(app).post('/api/data/patch').set('Cookie', cookie).send({ guests: { ...data1.body.guests, ...westEdit } });
    expect(save2.status).toBe(200);

    // 4. The archived event's guest rows must have survived.
    const data2 = await request(app).get('/api/data').set('Cookie', cookie);
    expect(data2.body.guests[created.slug].Mon).toEqual({ lunch: 400, dinner: 700 });
  });

  it('GET /api/data includes the eventLocations registry', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    const res = await request(app).get('/api/data').set('Cookie', cookie);
    const row = (res.body.eventLocations as Array<{ slug: string; name: string }>).find(r => r.slug === created.slug);
    expect(row).toBeTruthy();
    expect(row!.name).toContain('Zzz Evloc');
  });
});

// ── Hanos status map ────────────────────────────────────────────────────────

describe('GET /api/hanos/status locations map', () => {
  it('includes permanent + active event locations with their resolved account', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie, { hanosAccount: 'centraal' });
    const res = await request(app).get('/api/hanos/status').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.locations.west).toBeTruthy();
    expect(res.body.locations.centraal).toBeTruthy();
    expect(res.body.locations[created.slug]).toMatchObject({ account: 'centraal' });
    // Flat legacy fields still present:
    expect(typeof res.body.west).toBe('boolean');
    expect(typeof res.body.centraal).toBe('boolean');
  });
});

// ── Supplies: prep/stock at an event location ───────────────────────────────

describe('supply stock at an event location', () => {
  it('prep adds to the event bucket and survives round-trips; archived loc rejected for new moves', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    const supplyId = tid('sup');
    const mk = await request(app).post('/api/supplies').set('Cookie', cookie).send({
      id: supplyId, name: `${T} onions`, kind: 'standard', unit: 'jars',
      guestsPerUnit: 10, prepHorizonDays: 3, prepMode: 'per-location',
    });
    expect(mk.status).toBe(200);

    const prep = await request(app).post(`/api/supplies/${supplyId}/prep`).set('Cookie', cookie)
      .send({ location: created.slug, amount: 4 });
    expect(prep.status).toBe(200);
    expect(prep.body.stock[created.slug].amount).toBe(4);

    await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie);
    // Event stock preserved on read after archive (KNOWN key):
    const after = await request(app).get('/api/supplies?includeArchived=1').set('Cookie', cookie);
    const row = (after.body as Array<{ id: string; stock: Record<string, { amount: number }> }>).find(s => s.id === supplyId);
    expect(row!.stock[created.slug].amount).toBe(4);
    // Additive /prep stays ACTIVE-only…
    const prep2 = await request(app).post(`/api/supplies/${supplyId}/prep`).set('Cookie', cookie)
      .send({ location: created.slug, amount: 2 });
    expect(prep2.status).toBe(400);
    // …but the absolute stocktake SET accepts KNOWN — zeroing leftover stock
    // at a closed festival is legitimate cleanup (and required before the
    // supply-delete guard or a registry hard-delete can pass).
    const zero = await request(app).post(`/api/supplies/${supplyId}/stock`).set('Cookie', cookie)
      .send({ location: created.slug, amount: 0 });
    expect(zero.status).toBe(200);
    expect(zero.body.stock[created.slug].amount).toBe(0);
  });
});

// ── Hard delete (archived + zero-reference only) ─────────────────────────────

describe('DELETE /api/event-locations/:slug', () => {
  it('refuses while active, refuses while referenced, then deletes cleanly (incl. guest rows)', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);

    // Active → 400.
    expect((await request(app).delete(`/api/event-locations/${created.slug}`).set('Cookie', cookie)).status).toBe(400);

    // Reference it from a batch + enter guest counts.
    const b = fullBatch(tid('delref'), {
      inventory: [{ loc: created.slug, storage: 'Gastro', qty: 3, cookDate: '01/05/2026' }],
    });
    expect((await request(app).post('/api/batches').send(b)).status).toBe(201);
    const data = await request(app).get('/api/data').set('Cookie', cookie);
    const guests = data.body.guests;
    guests[created.slug].Tue = { lunch: 111, dinner: 222 };
    expect((await request(app).post('/api/data/patch').set('Cookie', cookie).send({ guests })).status).toBe(200);

    await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie);

    // Archived but still referenced by a batch → 400.
    const blocked = await request(app).delete(`/api/event-locations/${created.slug}`).set('Cookie', cookie);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/still references/);

    // Drop the reference (zero the stock via transfer, then delete the batch).
    await request(app).post(`/api/batches/${b.id}/transfer`).send({
      fromLoc: created.slug, fromStorage: 'Gastro', toLoc: 'west', toStorage: 'Gastro', qty: 3,
    });
    // The transfer leaves a 0-qty entry at the slug; PATCH the inventory clean.
    await request(app).patch(`/api/batches/${b.id}`).send({ inventory: [], shipments: [], services: [] });
    expect((await request(app).delete(`/api/batches/${b.id}`)).status).toBe(200);

    const ok = await request(app).delete(`/api/event-locations/${created.slug}`).set('Cookie', cookie);
    expect(ok.status).toBe(200);

    // Registry row gone (KNOWN no longer), guest rows purged.
    expect(isKnownLocation(created.slug)).toBe(false);
    const rows = await prisma.guest.findMany({ where: { location: created.slug } });
    expect(rows).toHaveLength(0);
  });

  it('403 without a director session', async () => {
    expect((await request(app).delete('/api/event-locations/ev-nope')).status).toBe(403);
  });
});

// ── Review-round additions (ultracode deep review of PR #125) ────────────────

describe('validateGuests sparse event blocks', () => {
  it('accepts a single-day event block (SSE sessions save one edited day at a time)', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    const week = () => {
      const w: Record<string, { lunch: number; dinner: number }> = {};
      for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) w[d] = { lunch: 0, dinner: 0 };
      return w;
    };
    const base = { west: week(), centraal: week() };
    // Sparse event block: valid. Bad day name / bad shape inside it: rejected.
    expect(validateGuests({ ...base, [created.slug]: { Mon: { lunch: 400, dinner: 700 } } })).toBeNull();
    expect(validateGuests({ ...base, [created.slug]: { Funday: { lunch: 1, dinner: 1 } } })).toMatch(/not a weekday/);
    expect(validateGuests({ ...base, [created.slug]: { Mon: { lunch: -1, dinner: 0 } } })).toMatch(/Invalid guest count/);
    // Permanent keys still require the full week.
    expect(validateGuests({ west: { Mon: { lunch: 1, dinner: 1 } }, centraal: week() } as never)).toMatch(/missing/);

    // End-to-end: a sparse patch merges into the scaffold instead of 400ing.
    const save = await request(app).post('/api/data/patch').set('Cookie', cookie)
      .send({ guests: { ...base, [created.slug]: { Tue: { lunch: 150, dinner: 300 } } } });
    expect(save.status).toBe(200);
    const data = await request(app).get('/api/data').set('Cookie', cookie);
    expect(data.body.guests[created.slug].Tue).toEqual({ lunch: 150, dinner: 300 });
    expect(data.body.guests[created.slug].Mon).toEqual({ lunch: 0, dinner: 0 }); // scaffold intact
  });
});

describe('event-location name hygiene (stored-XSS guard)', () => {
  it('rejects names with markup-capable characters, allows apostrophes', async () => {
    const cookie = await loginDirector();
    const base = { startDate: '2026-07-20', endDate: '2026-07-30' };
    expect((await request(app).post('/api/event-locations').set('Cookie', cookie)
      .send({ ...base, name: '<script>alert(1)</script>' })).status).toBe(400);
    expect((await request(app).post('/api/event-locations').set('Cookie', cookie)
      .send({ ...base, name: 'Fest "quoted"' })).status).toBe(400);
    expect((await request(app).post('/api/event-locations').set('Cookie', cookie)
      .send({ ...base, name: 'Fish & Chips Fest' })).status).toBe(400);
    const ok = await request(app).post('/api/event-locations').set('Cookie', cookie)
      .send({ ...base, name: `${NAME} Daan's Fest` });
    expect(ok.status).toBe(201);
  });
});

describe('phase-C inventory-route widenings', () => {
  it('ritual-completions, prep-checklist and inventory-completions accept ACTIVE event locs and reject archived ones', async () => {
    const cookie = await loginDirector();
    const created = await createEventLoc(cookie);
    const date = '2026-07-21';

    expect((await request(app).post('/api/ritual-completions').set('Cookie', cookie)
      .send({ loc: created.slug, date, completed: ['service-lunch'] })).status).toBe(200);
    expect((await request(app).post('/api/prep-checklist').set('Cookie', cookie)
      .send({ loc: created.slug, date, checked: ['x'] })).status).toBe(200);
    expect((await request(app).post('/api/inventory-completions').set('Cookie', cookie)
      .send({ loc: created.slug, window: 'lunch' })).status).toBe(200);
    const latest = await request(app).get('/api/inventory-completions/latest').set('Cookie', cookie);
    expect(latest.body[created.slug]).toBeTruthy();
    expect((await request(app).post('/api/standard-inventory').set('Cookie', cookie)
      .send({ location: 'ev-not-a-loc', items: [] })).status).toBe(400);

    await request(app).post(`/api/event-locations/${created.slug}/archive`).set('Cookie', cookie);
    expect((await request(app).post('/api/ritual-completions').set('Cookie', cookie)
      .send({ loc: created.slug, date, completed: [] })).status).toBe(400);
    // Cleanup the rows this test created (hard-delete purges them too, but
    // keep the shared DB tidy even when later assertions change).
    await prisma.ritualCompletion.deleteMany({ where: { loc: created.slug } });
    await prisma.prepChecklist.deleteMany({ where: { loc: created.slug } });
  });
});
