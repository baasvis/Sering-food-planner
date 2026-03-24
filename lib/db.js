// ─────────────────────────────────────────────────────────────────────────────
// POSTGRESQL DATA LAYER (PRISMA)
// ─────────────────────────────────────────────────────────────────────────────

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Validation ──

const VALID_TYPES = ['Soup', 'Main course', 'Dessert'];
const VALID_STORAGE = ['Gastro', 'Frozen', 'Vac-packed'];
const VALID_LOCATIONS = ['west', 'centraal'];
const VALID_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const VALID_MEALS = ['lunch', 'dinner'];

function validateBatch(b, label = 'Batch') {
  if (!b.id || typeof b.id !== 'string') return `${label}: missing or invalid id`;
  if (!b.name || typeof b.name !== 'string' || b.name.length > 200) return `${label}: invalid name`;
  if (!VALID_TYPES.includes(b.type)) return `${label}: invalid type "${b.type}"`;
  if (typeof b.stock !== 'number' || b.stock < 0 || b.stock > 99999) return `${label}: invalid stock`;
  if (typeof b.serving !== 'number' || b.serving < 1 || b.serving > 9999) return `${label}: invalid serving`;
  if (!VALID_STORAGE.includes(b.storage)) return `${label}: invalid storage`;
  if (!VALID_LOCATIONS.includes(b.location)) return `${label}: invalid location "${b.location}"`;
  if (typeof b.inTransit !== 'undefined' && typeof b.inTransit !== 'boolean') return `${label}: inTransit must be boolean`;
  if (typeof b.note !== 'undefined' && (typeof b.note !== 'string' || b.note.length > 1000)) return `${label}: invalid note`;
  if (!Array.isArray(b.services)) return `${label}: services must be an array`;
  for (const svc of b.services) {
    if (!VALID_LOCATIONS.includes(svc.loc)) return `${label}: invalid service location`;
    if (!svc.date || typeof svc.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(svc.date)) return `${label}: invalid service date (expected YYYY-MM-DD)`;
    if (!VALID_MEALS.includes(svc.meal)) return `${label}: invalid service meal`;
  }
  return null;
}

function validateBatches(batches) {
  if (!Array.isArray(batches)) return 'batches must be an array';
  if (batches.length > 500) return 'Too many batches (max 500)';
  const ids = new Set();
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    if (ids.has(b.id)) return `Batch ${i}: duplicate id "${b.id}"`;
    ids.add(b.id);
    const err = validateBatch(b, `Batch ${i}`);
    if (err) return err;
  }
  return null;
}

function validateGuests(guests) {
  if (!guests || typeof guests !== 'object') return 'guests must be an object';
  for (const loc of VALID_LOCATIONS) {
    if (!guests[loc]) return `guests.${loc} missing`;
    for (const day of VALID_DAYS) {
      if (!guests[loc][day]) return `guests.${loc}.${day} missing`;
      const g = guests[loc][day];
      if (typeof g.lunch !== 'number' || g.lunch < 0 || g.lunch > 9999) return `Invalid guest count`;
      if (typeof g.dinner !== 'number' || g.dinner < 0 || g.dinner > 9999) return `Invalid guest count`;
    }
  }
  return null;
}

// ── Default data ──

function getDefaultGuests() {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const west = {}, centraal = {};
  days.forEach(d => {
    west[d]     = { lunch: d === 'Sat' || d === 'Sun' ? 0 : 100, dinner: d === 'Sat' || d === 'Sun' ? 0 : 110 };
    centraal[d] = { lunch: d === 'Sat' || d === 'Sun' ? 0 : 80,  dinner: d === 'Sat' || d === 'Sun' ? 0 : 85  };
  });
  return { west, centraal };
}

// ── Row transformers (frontend shape ↔ Prisma shape) ──

function toBatchRow(b) {
  return {
    id: b.id,
    name: b.name,
    type: b.type,
    stock: b.stock,
    serving: b.serving || 280,
    storage: b.storage || 'Gastro',
    location: b.location || 'west',
    inTransit: !!b.inTransit,
    allergens: b.allergens || [],
    extraAllergens: b.extraAllergens || [],
    orderFor: !!b.orderFor,
    cookDate: b.cookDate || null,
    recipeSheetId: b.recipeSheetId || null,
    recipeVolume: b.recipeVolume || null,
    recipeIngredients: b.recipeIngredients || undefined,
    parentId: b.parentId || null,
    note: b.note || '',
    services: b.services || [],
    createdAt: b.createdAt || new Date().toISOString(),
  };
}

function toGuestRows(guests) {
  const rows = [];
  for (const [loc, days] of Object.entries(guests)) {
    for (const [day, meals] of Object.entries(days)) {
      rows.push({ location: loc, day, lunch: meals.lunch || 0, dinner: meals.dinner || 0 });
    }
  }
  return rows;
}

function toCateringRow(c) {
  return {
    id: c.id,
    name: c.name || '',
    date: c.date || null,
    guestCount: c.guestCount || 0,
    deliveryMode: c.deliveryMode || 'pickup',
    dishes: c.dishes || [],
    logisticsNotes: c.logisticsNotes || '',
    createdAt: c.createdAt || new Date().toISOString(),
  };
}

function toTransportRow(t) {
  return { id: t.id, text: t.text };
}

// ── Generic entity writer (delete-all + createMany pattern) ──

async function writeEntity(tx, model, items, transformer) {
  await model(tx).deleteMany();
  if (items && items.length > 0) {
    const data = transformer ? items.map(transformer) : items;
    await model(tx).createMany({ data });
  }
}

// Model accessors for writeEntity
const models = {
  batch:         (tx) => tx.batch,
  guest:         (tx) => tx.guest,
  catering:      (tx) => tx.catering,
  transportItem: (tx) => tx.transportItem,
};

// ── High-level database operations ──

async function dbReadAll() {
  try {
    const [batchRows, guestRows, recipeRows, cateringRows, transportRows] = await Promise.all([
      prisma.batch.findMany(),
      prisma.guest.findMany(),
      prisma.recipeIndex.findMany(),
      prisma.catering.findMany(),
      prisma.transportItem.findMany(),
    ]);

    const batches = batchRows.map(b => ({
      ...toBatchRow(b),
      services: Array.isArray(b.services) ? b.services : [],
    }));

    const guests = getDefaultGuests();
    for (const row of guestRows) {
      if (guests[row.location] && guests[row.location][row.day]) {
        guests[row.location][row.day].lunch = row.lunch;
        guests[row.location][row.day].dinner = row.dinner;
      }
    }

    const recipeIndex = recipeRows.map(r => ({
      id: r.id, name: r.name, type: r.type, recipeSheetId: r.recipeSheetId,
      allergens: r.allergens, costPerServing: r.costPerServing, structure: r.structure,
      seasonality: r.seasonality, servingTemp: r.servingTemp, servingSize: r.servingSize,
      recipeVolume: r.recipeVolume, recipeIngredients: r.recipeIngredients,
      createdAt: r.createdAt, avgSkill: r.avgSkill, avgSpeed: r.avgSpeed,
      avgBanger: r.avgBanger, timesServed: r.timesServed,
    }));

    const caterings = cateringRows.map(c => ({
      id: c.id, name: c.name, date: c.date, guestCount: c.guestCount,
      deliveryMode: c.deliveryMode, dishes: c.dishes, logisticsNotes: c.logisticsNotes,
    }));

    const transportItems = transportRows.map(t => ({ id: t.id, text: t.text }));

    return { batches, guests, recipeIndex, caterings, transportItems };
  } catch (e) {
    console.error('dbReadAll error:', e.message);
    return { batches: [], guests: getDefaultGuests(), recipeIndex: [], caterings: [], transportItems: [] };
  }
}

async function dbWriteAll(batches, guests, caterings, transportItems) {
  await prisma.$transaction(async (tx) => {
    await writeEntity(tx, models.batch, batches, toBatchRow);
    await writeEntity(tx, models.guest, toGuestRows(guests));
    await writeEntity(tx, models.catering, caterings, toCateringRow);
    await writeEntity(tx, models.transportItem, transportItems, toTransportRow);
  });
}

// ── Write lock — serialise writes to prevent data corruption ──

let writeLock = null;
async function withWriteLock(fn) {
  while (writeLock) await writeLock;
  let resolve;
  writeLock = new Promise(r => { resolve = r; });
  try { return await fn(); }
  finally { writeLock = null; resolve(); }
}

// ── Per-entity write helpers (for patch saves) ──

async function dbWriteBatches(batches) {
  await prisma.$transaction(async (tx) => writeEntity(tx, models.batch, batches, toBatchRow));
}

async function dbWriteGuests(guests) {
  await prisma.$transaction(async (tx) => writeEntity(tx, models.guest, toGuestRows(guests)));
}

async function dbWriteCaterings(caterings) {
  await prisma.$transaction(async (tx) => writeEntity(tx, models.catering, caterings, toCateringRow));
}

async function dbWriteTransportItems(items) {
  await prisma.$transaction(async (tx) => writeEntity(tx, models.transportItem, items, toTransportRow));
}

async function dbAppendLog(userEmail, userName, action, details) {
  try {
    await prisma.log.create({
      data: {
        timestamp: new Date().toISOString(),
        email: userEmail,
        name: userName,
        action,
        details,
      },
    });
  } catch (e) {
    console.error('Log append error:', e.message);
  }
}

module.exports = {
  prisma,
  dbReadAll,
  dbWriteAll,
  dbAppendLog,
  validateBatches,
  validateBatch,
  validateGuests,
  getDefaultGuests,
  withWriteLock,
  dbWriteBatches,
  dbWriteGuests,
  dbWriteCaterings,
  dbWriteTransportItems,
  toBatchRow,
};
