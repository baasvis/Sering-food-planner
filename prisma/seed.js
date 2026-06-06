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
  await seedDrinkRecipes();
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

function priceMap(p) {
  const out = {};
  if (p && typeof p === 'object') {
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith('_')) continue;
      out[k] = typeof v === 'number' ? v : null;
    }
  }
  return out;
}

// One recipe-mode Drink row from a drinks-recipes.json entry.
function recipeToDrinkRow(d) {
  const id = slugId('drink', d.name);
  const isBlock = d._category === 'building-block';
  const formats = [];
  if (!isBlock) {
    formats.push({ name: 'serve', volumeMl: d.serveVolumeMl || 0, glass: d.glass || undefined, price: priceMap(d.price) });
  }
  const locations = {};
  for (const [loc, info] of Object.entries(d.par || {})) {
    locations[loc] = { par: info && typeof info.amount === 'number' ? info.amount : null, active: true };
  }
  return {
    id,
    name: d.name,
    mode: 'recipe',
    category: d._category,
    subtype: d.subtype || '',
    abv: typeof d.abv === 'number' ? d.abv : 0,
    btwRate: typeof d.btw === 'number' ? d.btw : null,
    status: d.status === 'draft' ? 'draft' : 'published',
    archived: false,
    sellable: !isBlock,
    supplier: 'Homemade',
    orderUnit: '', orderUnitMl: null, packNote: '', itemId: null, deposit: 0, costPrice: null, costNote: '',
    formats,
    locations,
    info: {},
    tebiProductNames: Array.isArray(d.tebiProductNames) ? d.tebiProductNames : [],
    serveVolumeMl: d.serveVolumeMl || null,
    glass: d.glass || '',
    glassVolumeMl: d.glassVolumeMl || null,
    servingTemp: d.temp || '',
    characteristics: Array.isArray(d.characteristics) ? d.characteristics : [],
    garnish: Array.isArray(d.garnish) ? d.garnish : [],
    seasonality: '',
    serviceInstructions: d.serviceInstructions || '',
    prepSteps: Array.isArray(d.prepSteps) ? d.prepSteps : [],
    batch: d.batch || {},
    prepTime: d.prepTime || {},
    shelfLifeDays: typeof d.shelfLifeDays === 'number' ? d.shelfLifeDays : null,
    costPerServe: null, suggestedPrice: null,
    updatedAt: new Date(),
  };
}

async function seedDrinkRecipes() {
  const file = path.join(__dirname, '..', 'seeds', 'drinks-recipes.json');
  if (!fs.existsSync(file)) return;
  const count = await prisma.drink.count({ where: { mode: 'recipe' } });
  if (count > 0) { console.log(`Recipe drinks already exist (${count} rows) — skipping`); return; }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sections = [
    ['buildingBlocks', 'building-block'],
    ['cocktails', 'cocktail'],
    ['homemadeNA', 'homemade-na'],
    ['coffeeDrinks', 'coffee-drink'],
  ];
  const recipeDefs = [];
  for (const [key, defaultCat] of sections) {
    for (const d of (json[key] || [])) recipeDefs.push({ ...d, _category: d.category || defaultCat });
  }

  // 1) Insert the drink rows first so refDrinkId FKs resolve when rows go in.
  await prisma.drink.createMany({ data: recipeDefs.map(recipeToDrinkRow) });

  // 2) Initial homemade stock (litres/bottles) → DrinkStock pool rows.
  const stockRows = [];
  for (const d of recipeDefs) {
    const id = slugId('drink', d.name);
    for (const [loc, qty] of Object.entries(d.stock || {})) {
      if (typeof qty === 'number' && qty > 0) {
        stockRows.push({ id: slugId('dstk', `${d.name}-${loc}`), drinkId: id, location: loc, area: 'Uncounted (pre-stocktake)', qty, countedBy: 'seed', countedAt: null, updatedAt: new Date() });
      }
    }
  }
  if (stockRows.length) await prisma.drinkStock.createMany({ data: stockRows });

  // 3) Ingredient rows — resolve "ingredient:Name" → Ingredient id (loose),
  //    "drink:Name" → drink slug id (only if that drink exists). Unresolved
  //    refs keep the original name in `note` so the editor can surface them.
  const allDrinks = await prisma.drink.findMany({ select: { id: true } });
  const allIds = new Set(allDrinks.map(x => x.id));
  const ings = await prisma.ingredient.findMany({ select: { id: true, name: true } });
  const ingByName = new Map(ings.map(i => [i.name.toLowerCase().trim(), i.id]));

  const rowRows = [];
  for (const d of recipeDefs) {
    const drinkId = slugId('drink', d.name);
    (d.ingredients || []).forEach((ing, i) => {
      const ref = String(ing.ref || '');
      let refKind = 'ingredient', ingredientId = null, refDrinkId = null;
      let note = ing.note || '';
      if (ref.startsWith('drink:')) {
        const refName = ref.slice(6).trim();
        const rid = slugId('drink', refName);
        if (allIds.has(rid)) { refKind = 'drink'; refDrinkId = rid; }
        else { note = note ? `${note}; unresolved drink: ${refName}` : `unresolved drink: ${refName}`; }
      } else {
        const refName = ref.replace(/^ingredient:/, '').trim();
        const id = ingByName.get(refName.toLowerCase());
        if (id) ingredientId = id;
        else note = note ? `${note}; unlinked: ${refName}` : `unlinked: ${refName}`;
      }
      rowRows.push({
        id: `${drinkId}-row-${i}`, drinkId, sortOrder: i, refKind, ingredientId, refDrinkId,
        amount: typeof ing.amount === 'number' ? ing.amount : null,
        unit: ing.unit || 'ml', note: String(note).slice(0, 500),
      });
    });
  }
  if (rowRows.length) await prisma.drinkIngredientRow.createMany({ data: rowRows });
  console.log(`Seeded ${recipeDefs.length} recipe drinks + ${rowRows.length} ingredient rows`);

  // 4) Compute costs + reverse-engineer per-category markup targets. This is a
  //    compact port of shared/drink-cost.ts (the runtime source of truth, which
  //    recomputes on every save) so a fresh `prisma db seed` ships rich demo data.
  await computeDrinkCostsAndTargets();
}

async function getSeedDrinkConfig() {
  const def = { labourRatePerMin: 0.29, priceRounding: 0.1, btwRule: { alcoholicAbvThreshold: 0.5, alcoholic: 21, nonAlcoholic: 9 }, markupTargets: { defaultMultiple: 4.0 }, demandNudgeThresholdPct: 25, defaultShelfLifeDays: 7 };
  const row = await prisma.drinkConfig.findUnique({ where: { id: 'default' } });
  const c = (row && row.config) || {};
  return { ...def, ...c, btwRule: { ...def.btwRule, ...(c.btwRule || {}) }, markupTargets: { ...def.markupTargets, ...(c.markupTargets || {}) } };
}

async function computeDrinkCostsAndTargets() {
  const cfg = await getSeedDrinkConfig();
  const drinks = await prisma.drink.findMany({ include: { ingredientRows: true } });
  const ings = await prisma.ingredient.findMany({ select: { id: true, pricePer100: true } });
  const drinkById = new Map(drinks.map(d => [d.id, d]));
  const priceById = new Map(ings.map(i => [i.id, i.pricePer100 || 0]));
  const memo = new Map();
  const toG = (amt, unit) => {
    const u = (unit || '').toLowerCase();
    if (['kg', 'kilo', 'kilos', 'l', 'liter', 'liters', 'litre', 'litres'].includes(u)) return amt * 1000;
    return amt;
  };
  function rowsCost(rows, visiting) {
    let t = 0;
    for (const r of rows || []) {
      if (r.amount == null) continue;
      if (r.refKind === 'drink' && r.refDrinkId) { const ref = drinkById.get(r.refDrinkId); if (ref) t += r.amount * perMl(ref, visiting); }
      else if (r.refKind === 'ingredient' && r.ingredientId) { t += (toG(r.amount, r.unit) / 100) * (priceById.get(r.ingredientId) || 0); }
    }
    return t;
  }
  function perMl(d, visiting = new Set()) {
    if (memo.has(d.id)) return memo.get(d.id);
    if (visiting.has(d.id)) return 0;
    visiting.add(d.id);
    let v = 0;
    if (d.mode === 'catalogue') v = (d.costPrice != null && d.orderUnitMl > 0) ? d.costPrice / d.orderUnitMl : 0;
    else { const isB = d.category === 'building-block'; const uv = isB ? ((d.batch && d.batch.volumeMl) || 0) : (d.serveVolumeMl || 0); v = uv > 0 ? rowsCost(d.ingredientRows, visiting) / uv : 0; }
    visiting.delete(d.id); memo.set(d.id, v); return v;
  }
  function prebatchYield(d) {
    const pt = d.prepTime || {};
    if (pt.prebatchYieldServings > 0) return pt.prebatchYieldServings;
    const bv = (d.batch && d.batch.volumeMl) || 0; const sv = d.serveVolumeMl || 0;
    return (bv > 0 && sv > 0) ? bv / sv : 1;
  }
  function labour(d) { const pt = d.prepTime || {}; return ((pt.prebatchMin || 0) / prebatchYield(d) + (pt.perServeMin || 0)) * cfg.labourRatePerMin; }
  function btwOf(d) { return d.btwRate != null ? d.btwRate : (d.abv >= cfg.btwRule.alcoholicAbvThreshold ? cfg.btwRule.alcoholic : cfg.btwRule.nonAlcoholic); }
  function totalCost(d) {
    if (d.mode === 'catalogue') { const f = (d.formats || []).find(x => x.price && x.price.west != null) || (d.formats || [])[0]; return perMl(d) * ((f && f.volumeMl) || 0); }
    if (d.category === 'building-block') return perMl(d) * 1000;
    return rowsCost(d.ingredientRows, new Set()) + labour(d);
  }
  function servePrice(d) { const f = (d.formats || []).find(x => x.price && typeof x.price.west === 'number') || (d.formats || [])[0]; return f && f.price && typeof f.price.west === 'number' ? f.price.west : null; }

  // 1) Reverse-engineer per-category markup targets FIRST (so suggested prices
  //    below use the final targets). Only sample drinks with a real ingredient
  //    cost — a drink whose ingredients lack costPrice (cost ≈ 0) would yield a
  //    huge, meaningless markup and skew the median.
  const byCat = {};
  for (const d of drinks) {
    const price = servePrice(d);
    if (price == null || price <= 0) continue;
    const tc = totalCost(d);
    if (!(tc > 0)) continue;
    const ingCost = d.mode === 'catalogue' ? perMl(d) : rowsCost(d.ingredientRows, new Set());
    if (!(ingCost > 0)) continue; // incomplete cost data → don't let it skew the target
    const markup = (price / (1 + btwOf(d) / 100)) / tc;
    if (!Number.isFinite(markup) || markup <= 0 || markup > 12) continue; // >12× ⇒ missing cost data, not a real margin
    (byCat[d.category] = byCat[d.category] || []).push(markup);
  }
  const markupTargets = { ...cfg.markupTargets };
  for (const [cat, arr] of Object.entries(byCat)) {
    arr.sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    markupTargets[cat] = Math.round((arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2) * 10) / 10;
  }
  await prisma.drinkConfig.update({ where: { id: 'default' }, data: { config: { ...cfg, markupTargets } } });

  // 2) Store each recipe drink's cost + suggested price using the final targets.
  for (const d of drinks) {
    if (d.mode !== 'recipe') continue;
    const tc = Math.round(totalCost(d) * 100) / 100;
    const btw = btwOf(d);
    const target = markupTargets[d.category] > 0 ? markupTargets[d.category] : markupTargets.defaultMultiple;
    const sugg = tc > 0 ? Math.round((tc * target * (1 + btw / 100)) / cfg.priceRounding) * cfg.priceRounding : 0;
    await prisma.drink.update({ where: { id: d.id }, data: { costPerServe: tc, suggestedPrice: Math.round(sugg * 100) / 100 } });
  }
  console.log('Computed drink costs + reverse-engineered markup targets:', JSON.stringify(markupTargets));
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
