// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME MIGRATION: Google Sheets → PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────
//
// Usage: DATABASE_URL=... GOOGLE_CREDENTIALS=... DB_SHEET_ID=... node prisma/migrate-from-sheets.js
//
// This script reads all data from Google Sheets and writes it to PostgreSQL.
// Run this ONCE before switching to the Prisma-based code in production.
// ─────────────────────────────────────────────────────────────────────────────

try { require('dotenv').config(); } catch (e) {}
const { google } = require('googleapis');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

// ── Google Sheets helpers (self-contained, does not import lib/sheets.js) ──

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
  if (!credentials.client_email) throw new Error('GOOGLE_CREDENTIALS not set');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function readTab(sheets, sheetId, tabName) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: tabName });
    const rows = res.data.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0];
    return rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
      return obj;
    });
  } catch (e) {
    console.log(`  Tab "${tabName}" not found or empty — skipping`);
    return [];
  }
}

// ── Main migration ──

async function migrate() {
  const sheetId = process.env.DB_SHEET_ID;
  if (!sheetId) throw new Error('DB_SHEET_ID not set');

  console.log('Connecting to Google Sheets...');
  const sheets = getSheetsClient();

  console.log('Reading all tabs from Google Sheets...\n');

  // Read all tabs in parallel
  const [
    dishRows, serviceRows, guestRows, recipeRows, cateringRows,
    transportRows, ingredientRows, histRows, metaRows, nextWeeksRows,
    logRows, feedbackRows,
  ] = await Promise.all([
    readTab(sheets, sheetId, 'dishes'),
    readTab(sheets, sheetId, 'services'),
    readTab(sheets, sheetId, 'guests'),
    readTab(sheets, sheetId, 'recipe_index'),
    readTab(sheets, sheetId, 'caterings'),
    readTab(sheets, sheetId, 'transport_items'),
    readTab(sheets, sheetId, 'ingredients'),
    readTab(sheets, sheetId, 'guest_history'),
    readTab(sheets, sheetId, 'guest_history_meta'),
    readTab(sheets, sheetId, 'guests_next_weeks'),
    readTab(sheets, sheetId, 'log'),
    readTab(sheets, sheetId, 'feedback'),
  ]);

  console.log('Sheets data loaded:');
  console.log(`  dishes: ${dishRows.length}, services: ${serviceRows.length}, guests: ${guestRows.length}`);
  console.log(`  recipes: ${recipeRows.length}, caterings: ${cateringRows.length}, transport: ${transportRows.length}`);
  console.log(`  ingredients: ${ingredientRows.length}, history: ${histRows.length}, meta: ${metaRows.length}`);
  console.log(`  next_weeks: ${nextWeeksRows.length}, log: ${logRows.length}, feedback: ${feedbackRows.length}\n`);

  console.log('Writing to PostgreSQL...\n');

  // ── Dishes ──
  if (dishRows.length > 0) {
    await prisma.dish.createMany({
      data: dishRows.map(r => ({
        id: r.id,
        name: r.name || '',
        type: r.type || 'Soup',
        stock: parseFloat(r.stock) || 0,
        serving: parseInt(r.serving) || 280,
        storage: r.storage || 'Gastro',
        logistics: r.logistics || 'Sering West',
        allergens: r.allergens ? r.allergens.split('|').filter(Boolean) : [],
        extraAllergens: r.extra_allergens ? r.extra_allergens.split('|').filter(Boolean) : [],
        orderFor: r.order_for === 'true',
        cookMode: r.cook_mode || 'day',
        cookDay: r.cook_day || null,
        cookDate: r.cook_date || null,
        cookConfirmed: r.cook_confirmed === 'true',
        recipeSheetId: r.recipe_sheet_id || null,
        recipeVolume: parseFloat(r.recipe_volume) || null,
        recipeIngredients: r.recipe_ingredients ? JSON.parse(r.recipe_ingredients) : undefined,
        parentId: r.parent_id || null,
        createdAt: r.created_at || new Date().toISOString(),
      })),
    });
    console.log(`  ✓ dishes: ${dishRows.length} rows`);
  }

  // ── Services ──
  if (serviceRows.length > 0) {
    // Handle migration from old day-index format
    const now = new Date();
    const todayDow = now.getDay();
    const mondayOff = todayDow === 0 ? -6 : 1 - todayDow;
    const monday = new Date(now); monday.setDate(now.getDate() + mondayOff);

    await prisma.service.createMany({
      data: serviceRows.map(r => {
        let date = r.day;
        if (date && !date.includes('-')) {
          const dayIdx = parseInt(date);
          const target = new Date(monday); target.setDate(monday.getDate() + dayIdx);
          date = target.getFullYear() + '-' + String(target.getMonth() + 1).padStart(2, '0') + '-' + String(target.getDate()).padStart(2, '0');
        }
        return {
          id: r.id || `${r.dish_id}_${r.location}_${date}_${r.meal}`,
          dishId: r.dish_id,
          location: r.location,
          date,
          meal: r.meal,
        };
      }),
    });
    console.log(`  ✓ services: ${serviceRows.length} rows`);
  }

  // ── Guests ──
  if (guestRows.length > 0) {
    await prisma.guest.createMany({
      data: guestRows.map(r => ({
        location: r.location,
        day: r.day,
        lunch: parseInt(r.lunch) || 0,
        dinner: parseInt(r.dinner) || 0,
      })),
    });
    console.log(`  ✓ guests: ${guestRows.length} rows`);
  }

  // ── Recipe Index ──
  if (recipeRows.length > 0) {
    await prisma.recipeIndex.createMany({
      data: recipeRows.map(r => ({
        id: r.id,
        name: r.name || '',
        type: r.type || 'Soup',
        recipeSheetId: r.recipe_sheet_id || null,
        allergens: r.allergens ? r.allergens.split('|').filter(Boolean) : [],
        costPerServing: r.cost_per_serving || '',
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
    console.log(`  ✓ recipe_index: ${recipeRows.length} rows`);
  }

  // ── Caterings ──
  if (cateringRows.length > 0) {
    await prisma.catering.createMany({
      data: cateringRows.map(r => {
        let dishes = [];
        try { if (r.dishes) dishes = JSON.parse(r.dishes); } catch (e) {}
        return {
          id: r.id,
          name: r.name || '',
          date: r.date || null,
          guestCount: parseInt(r.guest_count) || 0,
          deliveryMode: r.delivery_mode || 'pickup',
          dishes,
          logisticsNotes: r.logistics_notes || '',
          createdAt: r.created_at || new Date().toISOString(),
        };
      }),
    });
    console.log(`  ✓ caterings: ${cateringRows.length} rows`);
  }

  // ── Transport Items ──
  if (transportRows.length > 0) {
    await prisma.transportItem.createMany({
      data: transportRows.map(r => ({ id: r.id, text: r.text || '' })),
    });
    console.log(`  ✓ transport_items: ${transportRows.length} rows`);
  }

  // ── Ingredients ──
  if (ingredientRows.length > 0) {
    await prisma.ingredient.createMany({
      data: ingredientRows.map(r => ({
        id: r.id,
        name: r.name || '',
        supplierName: r.supplier_name || '',
        category: r.category || '',
        unit: r.unit || 'Grams',
        supplier: r.supplier || '',
        orderCode: r.order_code || '',
        orderUnit: r.order_unit || '',
        orderUnitStandard: r.order_unit_standard || '',
        orderPrice: r.order_price ? parseFloat(r.order_price) : null,
        orderAmountGrams: parseFloat(r.order_amount_grams) || 0,
        allergens: r.allergens || '',
        notes: r.notes || '',
        storageLocation: r.storage_location || '',
        active: r.active !== 'false',
      })),
    });
    console.log(`  ✓ ingredients: ${ingredientRows.length} rows`);
  }

  // ── Guest History ──
  if (histRows.length > 0) {
    await prisma.guestHistory.createMany({
      data: histRows.map(r => ({
        location: r.location,
        meal: r.meal,
        date: r.date,
        count: parseInt(r.count) || 0,
      })),
    });
    console.log(`  ✓ guest_history: ${histRows.length} rows`);
  }

  // ── Guest History Meta ──
  if (metaRows.length > 0) {
    await prisma.guestHistoryMeta.createMany({
      data: metaRows.map(r => ({ key: r.key, value: r.value || '' })),
    });
    console.log(`  ✓ guest_history_meta: ${metaRows.length} rows`);
  }

  // ── Guests Next Weeks ──
  if (nextWeeksRows.length > 0) {
    await prisma.guestsNextWeeks.createMany({
      data: nextWeeksRows.map(r => ({
        mondayKey: r.monday_key,
        location: r.location,
        day: r.day,
        meal: r.meal,
        count: parseInt(r.count) || 0,
      })),
    });
    console.log(`  ✓ guests_next_weeks: ${nextWeeksRows.length} rows`);
  }

  // ── Log ──
  if (logRows.length > 0) {
    await prisma.log.createMany({
      data: logRows.map(r => ({
        timestamp: r.timestamp || '',
        email: r.email || r.user_email || '',
        name: r.name || r.user_name || '',
        action: r.action || '',
        details: r.details || '',
      })),
    });
    console.log(`  ✓ log: ${logRows.length} rows`);
  }

  // ── Feedback ──
  if (feedbackRows.length > 0) {
    await prisma.feedback.createMany({
      data: feedbackRows.map(r => ({
        timestamp: r.Timestamp || r.timestamp || '',
        user: r.User || r.user || 'anonymous',
        type: r.Type || r.type || 'general',
        screen: r.Screen || r.screen || '',
        text: r.Feedback || r.text || '',
        userAgent: r['User Agent'] || r.user_agent || '',
      })),
    });
    console.log(`  ✓ feedback: ${feedbackRows.length} rows`);
  }

  // ── Standard Inventory (from JSON file) ──
  const stdInvPath = path.join(__dirname, '..', 'data', 'standard-inventory.json');
  if (fs.existsSync(stdInvPath)) {
    const items = JSON.parse(fs.readFileSync(stdInvPath, 'utf8'));
    if (items.length > 0) {
      await prisma.standardInventory.createMany({ data: items });
      console.log(`  ✓ standard_inventory: ${items.length} rows (from data/standard-inventory.json)`);
    }
  }

  console.log('\n✓ Migration complete!');
}

migrate()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n✗ Migration failed:', e.message);
    await prisma.$disconnect();
    process.exit(1);
  });
