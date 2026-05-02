// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  ARCHIVED — DO NOT RUN AGAINST PRODUCTION ⚠️
//
// One-time XLSX import from the v3/v4 era (March 2026). The script below
// calls deleteMany() on 13 tables (batches/dishes/services/guests/ingredients/
// recipe_index/caterings/transport_items/guest_history/guest_history_meta/
// guests_next_weeks/log/feedback) before re-inserting. Running it against
// the live DB would wipe everything.
//
// Renamed to *.archived.js so `node prisma/import-xlsx.js ...` no longer
// resolves. If you genuinely need to re-import from a spreadsheet:
//   1. Understand exactly what deleteMany() targets,
//   2. Point DATABASE_URL at a scratch / staging DB,
//   3. Rename back to import-xlsx.js for the run.
//
// Refuses to start unless the explicit override is set:
if (process.env.ALLOW_ARCHIVED_DESTRUCTIVE_SCRIPT !== 'i-understand-this-wipes-tables') {
  console.error('REFUSED: this script wipes 13 tables. Read the header.');
  process.exit(1);
}

try { require('dotenv').config(); } catch (e) {}
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();
const xlsxPath = process.argv[2] || path.join(__dirname, '..', '..', '..', '..', 'Downloads', 'De Sering DB.xlsx');

function safeJsonParse(str, fallback) {
  if (!str && str !== 0) return fallback;
  if (typeof str === 'object') return str; // already parsed by XLSX
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

function getRows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).filter(r => r.length > 0).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  });
}

async function run() {
  console.log('Reading XLSX:', xlsxPath);
  const wb = XLSX.readFile(xlsxPath);
  console.log('Sheets:', wb.SheetNames.join(', '), '\n');

  // Clear all existing data
  console.log('Clearing existing data...');
  await prisma.service.deleteMany();
  await prisma.dish.deleteMany();
  await prisma.guest.deleteMany();
  await prisma.ingredient.deleteMany();
  await prisma.standardInventory.deleteMany();
  await prisma.recipeIndex.deleteMany();
  await prisma.catering.deleteMany();
  await prisma.transportItem.deleteMany();
  await prisma.guestHistory.deleteMany();
  await prisma.guestHistoryMeta.deleteMany();
  await prisma.guestsNextWeeks.deleteMany();
  await prisma.log.deleteMany();
  await prisma.feedback.deleteMany();

  // Dishes
  const dishes = getRows(wb, 'dishes');
  if (dishes.length > 0) {
    await prisma.dish.createMany({
      data: dishes.map(r => ({
        id: r.id,
        name: r.name || '',
        type: r.type || 'Soup',
        stock: parseFloat(r.stock) || 0,
        serving: parseInt(r.serving) || 280,
        storage: r.storage || 'Gastro',
        logistics: r.logistics || 'Sering West',
        allergens: r.allergens ? String(r.allergens).split('|').filter(Boolean) : [],
        extraAllergens: r.extra_allergens ? String(r.extra_allergens).split('|').filter(Boolean) : [],
        orderFor: r.order_for === 'true' || r.order_for === true,
        cookMode: r.cook_mode || 'day',
        cookDay: r.cook_day || null,
        cookDate: r.cook_date || null,
        cookConfirmed: r.cook_confirmed === 'true' || r.cook_confirmed === true,
        recipeSheetId: r.recipe_sheet_id || null,
        recipeVolume: parseFloat(r.recipe_volume) || null,
        recipeIngredients: r.recipe_ingredients ? JSON.parse(r.recipe_ingredients) : undefined,
        parentId: r.parent_id || null,
        createdAt: r.created_at || new Date().toISOString(),
      })),
    });
    console.log('dishes:', dishes.length);
  }

  // Services
  const services = getRows(wb, 'services');
  if (services.length > 0) {
    await prisma.service.createMany({
      data: services.map(r => ({
        id: r.id || `${r.dish_id}_${r.location}_${r.day}_${r.meal}`,
        dishId: r.dish_id,
        location: r.location,
        date: r.day,
        meal: r.meal,
      })),
    });
    console.log('services:', services.length);
  }

  // Guests
  const guests = getRows(wb, 'guests');
  if (guests.length > 0) {
    await prisma.guest.createMany({
      data: guests.map(r => ({
        location: r.location,
        day: r.day,
        lunch: parseInt(r.lunch) || 0,
        dinner: parseInt(r.dinner) || 0,
      })),
    });
    console.log('guests:', guests.length);
  }

  // Recipe index
  const recipes = getRows(wb, 'recipe_index');
  if (recipes.length > 0) {
    await prisma.recipeIndex.createMany({
      data: recipes.map(r => ({
        id: r.id,
        name: r.name || '',
        type: r.type || 'Soup',
        recipeSheetId: r.recipe_sheet_id || null,
        allergens: r.allergens ? String(r.allergens).split('|').filter(Boolean) : [],
        costPerServing: r.cost_per_serving ? String(r.cost_per_serving) : '',
        structure: r.structure || '',
        seasonality: r.seasonality || '',
        servingTemp: r.serving_temp || '',
        servingSize: parseInt(r.serving_size) || 280,
        recipeVolume: parseFloat(r.recipe_volume) || null,
        recipeIngredients: r.recipe_ingredients ? JSON.parse(r.recipe_ingredients) : undefined,
        createdAt: r.created_at || new Date().toISOString(),
        avgSkill: parseFloat(r.avg_skill) || 0,
        avgSpeed: parseFloat(r.avg_speed) || 0,
        avgBanger: parseFloat(r.avg_banger) || 0,
        timesServed: parseInt(r.times_served) || 0,
      })),
    });
    console.log('recipes:', recipes.length);
  }

  // Transport items
  const transport = getRows(wb, 'transport_items');
  if (transport.length > 0) {
    await prisma.transportItem.createMany({
      data: transport.map(r => ({ id: r.id, text: r.text || '' })),
    });
    console.log('transport:', transport.length);
  }

  // Ingredients (updated schema with types, priceHistory, stock, nutrition, etc.)
  const ingredients = getRows(wb, 'ingredients');
  if (ingredients.length > 0) {
    await prisma.ingredient.createMany({
      data: ingredients.map(r => ({
        id: r.id,
        name: r.name || '',
        supplierName: r.supplier_name || '',
        types: safeJsonParse(r.types, []),
        category: r.category || '',
        unit: r.unit || 'Grams',
        supplier: r.supplier || '',
        orderCode: r.order_code ? String(r.order_code) : '',
        orderUnit: r.order_unit || '',
        orderUnitStandard: r.order_unit_standard || '',
        orderPrice: r.order_price != null && r.order_price !== '' ? parseFloat(r.order_price) : null,
        orderAmountGrams: parseFloat(r.order_amount_grams) || 0,
        priceLevel: r.price_level || '',
        pricePer100g: parseFloat(r.price_per_100g) || 0,
        priceHistory: safeJsonParse(r.price_history, []),
        priceAlert: r.price_alert === 'true' || r.price_alert === true,
        storageLocations: safeJsonParse(r.storage_locations, {}),
        stock: safeJsonParse(r.stock, {}),
        nutrition: safeJsonParse(r.nutrition, {}),
        allergens: r.allergens || '',
        notes: r.notes || '',
        active: r.active !== 'false' && r.active !== false,
      })),
    });
    console.log('ingredients:', ingredients.length);
  }

  // Guest history
  const history = getRows(wb, 'guest_history');
  if (history.length > 0) {
    await prisma.guestHistory.createMany({
      data: history.map(r => ({
        location: r.location,
        meal: r.meal,
        date: r.date,
        count: parseInt(r.count) || 0,
      })),
    });
    console.log('guest_history:', history.length);
  }

  // Guest history meta
  const meta = getRows(wb, 'guest_history_meta');
  if (meta.length > 0) {
    await prisma.guestHistoryMeta.createMany({
      data: meta.map(r => ({ key: r.key, value: r.value ? String(r.value) : '' })),
    });
    console.log('guest_history_meta:', meta.length);
  }

  // Guests next weeks
  const nextWeeks = getRows(wb, 'guests_next_weeks');
  if (nextWeeks.length > 0) {
    await prisma.guestsNextWeeks.createMany({
      data: nextWeeks.map(r => ({
        mondayKey: r.monday_key,
        location: r.location,
        day: r.day,
        meal: r.meal,
        count: parseInt(r.count) || 0,
      })),
    });
    console.log('guests_next_weeks:', nextWeeks.length);
  }

  // Log (no headers — raw data rows)
  const logWs = wb.Sheets['log'];
  if (logWs) {
    const logData = XLSX.utils.sheet_to_json(logWs, { header: 1 });
    const validRows = logData.filter(r => r.length >= 5);
    if (validRows.length > 0) {
      await prisma.log.createMany({
        data: validRows.map(r => ({
          timestamp: String(r[0] || ''),
          email: String(r[1] || ''),
          name: String(r[2] || ''),
          action: String(r[3] || ''),
          details: String(r[4] || ''),
        })),
      });
      console.log('log:', validRows.length);
    }
  }

  // Standard inventory (from seed file)
  const stdInvSeed = path.join(__dirname, '..', 'seeds', 'standard-inventory.json');
  if (fs.existsSync(stdInvSeed)) {
    const items = JSON.parse(fs.readFileSync(stdInvSeed, 'utf8'));
    await prisma.standardInventory.createMany({ data: items });
    console.log('standard_inventory:', items.length, '(from seed)');
  }

  console.log('\nImport complete!');
}

run()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\nImport failed:', e.message);
    console.error(e.stack);
    await prisma.$disconnect();
    process.exit(1);
  });
