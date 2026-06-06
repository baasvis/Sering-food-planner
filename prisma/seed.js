// ─────────────────────────────────────────────────────────────────────────────
// PRISMA SEED SCRIPT — Seeds fresh Postgres with initial data
// ─────────────────────────────────────────────────────────────────────────────

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function main() {
  // Seed ingredients
  const ingredientsSeed = path.join(__dirname, '..', 'seeds', 'ingredients.json');
  if (fs.existsSync(ingredientsSeed)) {
    const count = await prisma.ingredient.count();
    if (count === 0) {
      const ingredients = JSON.parse(fs.readFileSync(ingredientsSeed, 'utf8'));
      await prisma.ingredient.createMany({ data: ingredients });
      console.log(`Seeded ${ingredients.length} ingredients`);
    } else {
      console.log(`Ingredients already exist (${count} rows) — skipping seed`);
    }
  }

  // Seed standard inventory
  const stdInvSeed = path.join(__dirname, '..', 'seeds', 'standard-inventory.json');
  if (fs.existsSync(stdInvSeed)) {
    const count = await prisma.standardInventory.count();
    if (count === 0) {
      const items = JSON.parse(fs.readFileSync(stdInvSeed, 'utf8'));
      await prisma.standardInventory.createMany({ data: items });
      console.log(`Seeded ${items.length} standard inventory items`);
    } else {
      console.log(`Standard inventory already exists (${count} rows) — skipping seed`);
    }
  }

  // Seed default guests
  const count = await prisma.guest.count();
  if (count === 0) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const guestData = [];
    for (const loc of ['west', 'centraal']) {
      for (const day of days) {
        const isWeekend = day === 'Sat' || day === 'Sun';
        guestData.push({
          location: loc,
          day,
          lunch: isWeekend ? 0 : (loc === 'west' ? 100 : 80),
          dinner: isWeekend ? 0 : (loc === 'west' ? 110 : 85),
        });
      }
    }
    await prisma.guest.createMany({ data: guestData });
    console.log('Seeded default guest counts (14 rows)');
  } else {
    console.log(`Guests already exist (${count} rows) — skipping seed`);
  }

  // ── Competencies module ──
  // Chunks are not seeded — they sync from Notion (see lib/notion-sync.ts).
  // People launch empty; the JSON file is a placeholder for a future name list.
  const peopleSeed = path.join(__dirname, '..', 'seeds', 'competency-people.json');
  if (fs.existsSync(peopleSeed)) {
    const peopleCount = await prisma.person.count();
    if (peopleCount === 0) {
      const people = JSON.parse(fs.readFileSync(peopleSeed, 'utf8'));
      if (people.length > 0) {
        await prisma.person.createMany({ data: people });
        console.log(`Seeded ${people.length} competency people`);
      }
    } else {
      console.log(`People already exist (${peopleCount} rows) — skipping seed`);
    }
  }

  // ── Drinks module (idempotent, mode-scoped so M3 recipe seeding stays separate) ──
  await seedDrinkSuppliers();
  await seedDrinkCatalogue();
  await seedDrinkConfig();
}

// ── Drinks seeding helpers ──

// Deterministic, charset-safe id from a name (so re-seeding a wiped DB yields
// stable ids and name→id refs resolve consistently).
function slugId(prefix, name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180);
  return `${prefix}-${s || 'x'}`;
}

// Best-effort volume (ml) of one order unit, parsed from the pack note. Helps
// the M3 cost-per-serve math; null when unknown (manager fills it in later).
function parseOrderUnitMl(packNote, orderUnit) {
  const text = `${packNote || ''} ${orderUnit || ''}`;
  let m = text.match(/(\d+)\s*[x×]\s*(\d+)\s*ml/i); // "24 x 200ml"
  if (m) return parseInt(m[1], 10) * parseInt(m[2], 10);
  m = text.match(/(\d+(?:\.\d+)?)\s*L\b/i);          // "20L"
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = text.match(/(\d+)\s*ml/i);                      // "750ml"
  if (m) return parseInt(m[1], 10);
  return null;
}

async function seedDrinkSuppliers() {
  const file = path.join(__dirname, '..', 'seeds', 'drinks-suppliers.json');
  if (!fs.existsSync(file)) return;
  const count = await prisma.drinkSupplier.count();
  if (count > 0) { console.log(`Drink suppliers already exist (${count} rows) — skipping`); return; }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = (json.suppliers || []).map((s) => ({
    id: slugId('sup', s.name),
    name: s.name,
    products: s.products || '',
    orderDays: Array.isArray(s.orderDays) ? s.orderDays : [],
    orderDaysNote: s.orderDaysNote || '',
    orderCutoff: '',
    deliveryWindow: s.deliveryWindow || '',
    contact: s.contact || {},
    minimumOrder: s.minimumOrder == null ? '' : String(s.minimumOrder),
    notes: s.notes || '',
    priceListRef: s.priceListRef || '',
    updatedAt: new Date(),
  }));
  if (rows.length) await prisma.drinkSupplier.createMany({ data: rows });
  console.log(`Seeded ${rows.length} drink suppliers`);
}

async function seedDrinkCatalogue() {
  const file = path.join(__dirname, '..', 'seeds', 'drinks-catalogue.json');
  if (!fs.existsSync(file)) return;
  const count = await prisma.drink.count({ where: { mode: 'catalogue' } });
  if (count > 0) { console.log(`Catalogue drinks already exist (${count} rows) — skipping`); return; }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const drinkRows = [];
  const stockRows = [];
  for (const d of (json.drinks || [])) {
    const id = slugId('drink', d.name);
    const sellable = d.sellable !== false;
    const locations = {};
    for (const [loc, info] of Object.entries(d.locations || {})) {
      locations[loc] = { par: info.par == null ? null : info.par, active: true };
      if (typeof info.stock === 'number' && info.stock > 0) {
        stockRows.push({
          id: slugId('dstk', `${d.name}-${loc}`),
          drinkId: id,
          location: loc,
          area: 'Uncounted (pre-stocktake)',
          qty: info.stock,
          countedBy: 'seed',
          countedAt: null,
          updatedAt: new Date(),
        });
      }
    }
    drinkRows.push({
      id,
      name: d.name,
      mode: 'catalogue',
      category: d.category || 'soft',
      subtype: d.subtype || '',
      abv: typeof d.abv === 'number' ? d.abv : 0,
      btwRate: null,
      // Seed the live bar catalogue as published; consumables/glassware (sellable
      // false) seed as draft so they never reach service cards. See DECISIONS.md.
      status: sellable ? 'published' : 'draft',
      archived: false,
      sellable,
      supplier: d.supplier || '',
      orderUnit: d.orderUnit || '',
      orderUnitMl: parseOrderUnitMl(d.packNote, d.orderUnit),
      packNote: d.packNote || '',
      itemId: d.itemId || null,
      deposit: typeof d.deposit === 'number' ? d.deposit : 0,
      costPrice: typeof d.costPrice === 'number' ? d.costPrice : null,
      costNote: d.costNote || '',
      formats: Array.isArray(d.formats) ? d.formats : [],
      locations,
      info: d.info || {},
      tebiProductNames: Array.isArray(d.tebiProductNames) ? d.tebiProductNames : [],
      serveVolumeMl: null, glass: '', glassVolumeMl: null, servingTemp: '',
      characteristics: [], garnish: [], seasonality: '', serviceInstructions: '',
      prepSteps: [], batch: {}, prepTime: {}, shelfLifeDays: null,
      costPerServe: null, suggestedPrice: null,
      updatedAt: new Date(),
    });
  }
  if (drinkRows.length) await prisma.drink.createMany({ data: drinkRows });
  if (stockRows.length) await prisma.drinkStock.createMany({ data: stockRows });
  console.log(`Seeded ${drinkRows.length} catalogue drinks + ${stockRows.length} stock rows`);
}

async function seedDrinkConfig() {
  const existing = await prisma.drinkConfig.findUnique({ where: { id: 'default' } });
  if (existing && existing.config && Object.keys(existing.config).length > 0) {
    console.log('Drink config already set — skipping');
    return;
  }
  const file = path.join(__dirname, '..', 'seeds', 'drinks-assortments.json');
  const fallback = { alcoholicAbvThreshold: 0.5, alcoholic: 21, nonAlcoholic: 9 };
  let cfg = {
    labourRatePerMin: 0.29, priceRounding: 0.1, btwRule: fallback,
    markupTargets: { defaultMultiple: 4.0 }, demandNudgeThresholdPct: 25, defaultShelfLifeDays: 7,
  };
  if (fs.existsSync(file)) {
    const c = (JSON.parse(fs.readFileSync(file, 'utf8')).config) || {};
    const markupTargets = { defaultMultiple: 4.0 };
    for (const [k, v] of Object.entries(c.markupTargets || {})) {
      if (k === '_note') continue;
      markupTargets[k] = v; // null targets fall back to defaultMultiple at compute time (M3)
    }
    cfg = {
      labourRatePerMin: c.labourRatePerMin ?? 0.29,
      priceRounding: c.priceRounding ?? 0.1,
      btwRule: c.btwRule || fallback,
      markupTargets,
      demandNudgeThresholdPct: c.demandNudgeThresholdPct ?? 25,
      defaultShelfLifeDays: c.defaultShelfLifeDays ?? 7,
    };
  }
  await prisma.drinkConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default', config: cfg },
    update: { config: cfg },
  });
  console.log('Seeded drink config');
}

main()
  .then(() => {
    console.log('Seed complete');
    return prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('Seed error:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
