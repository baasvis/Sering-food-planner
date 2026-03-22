// ─────────────────────────────────────────────────────────────────────────────
// POSTGRESQL DATA LAYER (PRISMA) — REPLACES GOOGLE SHEETS
// ─────────────────────────────────────────────────────────────────────────────

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Validation (moved from sheets.js, unchanged) ──

const VALID_TYPES = ['Soup', 'Main course', 'Dessert'];
const VALID_STORAGE = ['Gastro', 'Frozen', 'Vac-packed'];
const VALID_LOGISTICS = ['Sering West', 'Transport to Sering Centraal', 'Transport to Sering West', 'Sering Centraal'];
const VALID_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const VALID_MEALS = ['lunch', 'dinner'];
const VALID_LOCATIONS = ['west', 'centraal'];

function validateDishes(dishes) {
  if (!Array.isArray(dishes)) return 'dishes must be an array';
  if (dishes.length > 500) return 'Too many dishes (max 500)';
  const ids = new Set();
  for (let i = 0; i < dishes.length; i++) {
    const d = dishes[i];
    if (!d.id || typeof d.id !== 'string') return `Dish ${i}: missing or invalid id`;
    if (ids.has(d.id)) return `Dish ${i}: duplicate id "${d.id}"`;
    ids.add(d.id);
    if (!d.name || typeof d.name !== 'string' || d.name.length > 200) return `Dish ${i}: invalid name`;
    if (!VALID_TYPES.includes(d.type)) return `Dish ${i}: invalid type "${d.type}"`;
    if (typeof d.stock !== 'number' || d.stock < 0 || d.stock > 99999) return `Dish ${i}: invalid stock`;
    if (typeof d.serving !== 'number' || d.serving < 1 || d.serving > 9999) return `Dish ${i}: invalid serving`;
    if (!VALID_STORAGE.includes(d.storage)) return `Dish ${i}: invalid storage`;
    if (!VALID_LOGISTICS.includes(d.logistics)) return `Dish ${i}: invalid logistics`;
    if (!Array.isArray(d.services)) return `Dish ${i}: services must be an array`;
    for (const svc of d.services) {
      if (!VALID_LOCATIONS.includes(svc.loc)) return `Dish ${i}: invalid service location`;
      if (!svc.date || typeof svc.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(svc.date)) return `Dish ${i}: invalid service date (expected YYYY-MM-DD)`;
      if (!VALID_MEALS.includes(svc.meal)) return `Dish ${i}: invalid service meal`;
    }
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

// ── High-level database operations ──

async function dbReadAll() {
  try {
    const [dishesWithServices, guestRows, recipeRows, cateringRows, transportRows] = await Promise.all([
      prisma.dish.findMany({ include: { services: true } }),
      prisma.guest.findMany(),
      prisma.recipeIndex.findMany(),
      prisma.catering.findMany(),
      prisma.transportItem.findMany(),
    ]);

    // Transform dishes: map Prisma services to the {loc, date, meal} shape the frontend expects
    const dishes = dishesWithServices.map(d => ({
      id: d.id,
      name: d.name,
      type: d.type,
      stock: d.stock,
      serving: d.serving,
      storage: d.storage,
      logistics: d.logistics,
      allergens: d.allergens,
      extraAllergens: d.extraAllergens,
      orderFor: d.orderFor,
      cookMode: d.cookMode,
      cookDay: d.cookDay,
      cookDate: d.cookDate,
      cookConfirmed: d.cookConfirmed,
      recipeSheetId: d.recipeSheetId,
      recipeVolume: d.recipeVolume,
      recipeIngredients: d.recipeIngredients,
      parentId: d.parentId,
      createdAt: d.createdAt,
      services: d.services.map(s => ({ loc: s.location, date: s.date, meal: s.meal })),
    }));

    // Transform guests: flat rows → nested {west: {Mon: {lunch, dinner}}} object
    const guests = getDefaultGuests();
    for (const row of guestRows) {
      if (guests[row.location] && guests[row.location][row.day]) {
        guests[row.location][row.day].lunch = row.lunch;
        guests[row.location][row.day].dinner = row.dinner;
      }
    }

    // Transform recipes
    const recipeIndex = recipeRows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      recipeSheetId: r.recipeSheetId,
      allergens: r.allergens,
      costPerServing: r.costPerServing,
      structure: r.structure,
      seasonality: r.seasonality,
      servingTemp: r.servingTemp,
      servingSize: r.servingSize,
      recipeVolume: r.recipeVolume,
      recipeIngredients: r.recipeIngredients,
      createdAt: r.createdAt,
      avgSkill: r.avgSkill,
      avgSpeed: r.avgSpeed,
      avgBanger: r.avgBanger,
      timesServed: r.timesServed,
    }));

    // Transform caterings
    const caterings = cateringRows.map(c => ({
      id: c.id,
      name: c.name,
      date: c.date,
      guestCount: c.guestCount,
      deliveryMode: c.deliveryMode,
      dishes: c.dishes,
      logisticsNotes: c.logisticsNotes,
    }));

    // Transport items
    const transportItems = transportRows.map(t => ({ id: t.id, text: t.text }));

    return { dishes, guests, recipeIndex, caterings, transportItems };
  } catch (e) {
    console.error('dbReadAll error:', e.message);
    return { dishes: [], guests: getDefaultGuests(), recipeIndex: [], caterings: [], transportItems: [] };
  }
}

async function dbWriteAll(dishes, guests, caterings, transportItems) {
  await prisma.$transaction(async (tx) => {
    // Delete all existing data (same pattern as Sheets overwrite-all)
    await tx.service.deleteMany();
    await tx.dish.deleteMany();
    await tx.guest.deleteMany();
    await tx.catering.deleteMany();
    await tx.transportItem.deleteMany();

    // Write dishes
    if (dishes.length > 0) {
      await tx.dish.createMany({
        data: dishes.map(d => ({
          id: d.id,
          name: d.name,
          type: d.type,
          stock: d.stock,
          serving: d.serving || 280,
          storage: d.storage || 'Gastro',
          logistics: d.logistics || 'Sering West',
          allergens: d.allergens || [],
          extraAllergens: d.extraAllergens || [],
          orderFor: !!d.orderFor,
          cookMode: d.cookMode || 'day',
          cookDay: d.cookDay || null,
          cookDate: d.cookDate || null,
          cookConfirmed: !!d.cookConfirmed,
          recipeSheetId: d.recipeSheetId || null,
          recipeVolume: d.recipeVolume || null,
          recipeIngredients: d.recipeIngredients || undefined,
          parentId: d.parentId || null,
          createdAt: d.createdAt || new Date().toISOString(),
        })),
      });

      // Write services (exploded from dish.services)
      const serviceData = [];
      for (const dish of dishes) {
        for (const svc of (dish.services || [])) {
          serviceData.push({
            id: `${dish.id}_${svc.loc}_${svc.date}_${svc.meal}`,
            dishId: dish.id,
            location: svc.loc,
            date: svc.date,
            meal: svc.meal,
          });
        }
      }
      if (serviceData.length > 0) {
        await tx.service.createMany({ data: serviceData });
      }
    }

    // Write guests
    const guestData = [];
    for (const [loc, days] of Object.entries(guests)) {
      for (const [day, meals] of Object.entries(days)) {
        guestData.push({ location: loc, day, lunch: meals.lunch || 0, dinner: meals.dinner || 0 });
      }
    }
    if (guestData.length > 0) {
      await tx.guest.createMany({ data: guestData });
    }

    // Write caterings
    if (caterings && caterings.length > 0) {
      await tx.catering.createMany({
        data: caterings.map(c => ({
          id: c.id,
          name: c.name || '',
          date: c.date || null,
          guestCount: c.guestCount || 0,
          deliveryMode: c.deliveryMode || 'pickup',
          dishes: c.dishes || [],
          logisticsNotes: c.logisticsNotes || '',
          createdAt: c.createdAt || new Date().toISOString(),
        })),
      });
    }

    // Write transport items
    if (transportItems && transportItems.length > 0) {
      await tx.transportItem.createMany({
        data: transportItems.map(t => ({ id: t.id, text: t.text })),
      });
    }
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

// ── Per-tab write helpers (for patch saves) ──

async function dbWriteDishes(dishes) {
  await prisma.$transaction(async (tx) => {
    await tx.service.deleteMany();
    await tx.dish.deleteMany();
    if (dishes.length > 0) {
      await tx.dish.createMany({
        data: dishes.map(d => ({
          id: d.id,
          name: d.name,
          type: d.type,
          stock: d.stock,
          serving: d.serving || 280,
          storage: d.storage || 'Gastro',
          logistics: d.logistics || 'Sering West',
          allergens: d.allergens || [],
          extraAllergens: d.extraAllergens || [],
          orderFor: !!d.orderFor,
          cookMode: d.cookMode || 'day',
          cookDay: d.cookDay || null,
          cookDate: d.cookDate || null,
          cookConfirmed: !!d.cookConfirmed,
          recipeSheetId: d.recipeSheetId || null,
          recipeVolume: d.recipeVolume || null,
          recipeIngredients: d.recipeIngredients || undefined,
          parentId: d.parentId || null,
          createdAt: d.createdAt || new Date().toISOString(),
        })),
      });
      const serviceData = [];
      for (const dish of dishes) {
        for (const svc of (dish.services || [])) {
          serviceData.push({
            id: `${dish.id}_${svc.loc}_${svc.date}_${svc.meal}`,
            dishId: dish.id,
            location: svc.loc,
            date: svc.date,
            meal: svc.meal,
          });
        }
      }
      if (serviceData.length > 0) {
        await tx.service.createMany({ data: serviceData });
      }
    }
  });
}

async function dbWriteGuests(guests) {
  await prisma.$transaction(async (tx) => {
    await tx.guest.deleteMany();
    const guestData = [];
    for (const [loc, days] of Object.entries(guests)) {
      for (const [day, meals] of Object.entries(days)) {
        guestData.push({ location: loc, day, lunch: meals.lunch || 0, dinner: meals.dinner || 0 });
      }
    }
    if (guestData.length > 0) {
      await tx.guest.createMany({ data: guestData });
    }
  });
}

async function dbWriteCaterings(caterings) {
  await prisma.$transaction(async (tx) => {
    await tx.catering.deleteMany();
    if (caterings && caterings.length > 0) {
      await tx.catering.createMany({
        data: caterings.map(c => ({
          id: c.id,
          name: c.name || '',
          date: c.date || null,
          guestCount: c.guestCount || 0,
          deliveryMode: c.deliveryMode || 'pickup',
          dishes: c.dishes || [],
          logisticsNotes: c.logisticsNotes || '',
          createdAt: c.createdAt || new Date().toISOString(),
        })),
      });
    }
  });
}

async function dbWriteTransportItems(items) {
  await prisma.$transaction(async (tx) => {
    await tx.transportItem.deleteMany();
    if (items && items.length > 0) {
      await tx.transportItem.createMany({
        data: items.map(t => ({ id: t.id, text: t.text })),
      });
    }
  });
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
  validateDishes,
  validateGuests,
  getDefaultGuests,
  withWriteLock,
  dbWriteDishes,
  dbWriteGuests,
  dbWriteCaterings,
  dbWriteTransportItems,
};
