// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SHEETS CLIENT, DATA LAYER, VALIDATION & WRITE LOCK
// ─────────────────────────────────────────────────────────────────────────────

const { google } = require('googleapis');
const { CONFIG } = require('./config');

// ── Sheets client ──

function getSheetsClient() {
  try {
    const credentials = JSON.parse(CONFIG.GOOGLE_CREDENTIALS);
    if (!credentials.client_email) return null;
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
  } catch (e) {
    console.error('Could not create Sheets client:', e.message);
    return null;
  }
}

async function readTab(sheets, sheetId, tabName) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: tabName });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  });
}

async function writeTab(sheets, sheetId, tabName, headers, rows) {
  const values = [headers, ...rows];
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId, range: tabName + '!A1',
    valueInputOption: 'RAW', requestBody: { values },
  });
  if (rows.length < 500) {
    try {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: sheetId,
        range: tabName + '!A' + (rows.length + 2) + ':Z1000',
      });
    } catch (e) { /* ignore */ }
  }
}

async function ensureTabsExist(sheets, sheetId, tabNames) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = meta.data.sheets.map(s => s.properties.title);
  const toCreate = tabNames.filter(name => !existing.includes(name));
  if (toCreate.length === 0) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: toCreate.map(title => ({ addSheet: { properties: { title } } })) }
  });
}

// ── Header constants ──

const DISH_HEADERS = [
  'id','name','type','stock','serving','storage','logistics',
  'allergens','extra_allergens','order_for','cook_mode','cook_day',
  'cook_date','cook_confirmed','recipe_sheet_id','recipe_volume','recipe_ingredients',
  'parent_id','created_at'
];
const SERVICE_HEADERS = ['id','dish_id','location','day','meal'];
const GUEST_HEADERS   = ['location','day','lunch','dinner'];
const RECIPE_INDEX_HEADERS = [
  'id','name','type','recipe_sheet_id','allergens','cost_per_serving',
  'structure','seasonality','serving_temp','serving_size','recipe_volume',
  'recipe_ingredients','created_at','avg_skill','avg_speed','avg_banger','times_served'
];
const CATERING_HEADERS = ['id','name','date','guest_count','delivery_mode','dishes','logistics_notes','created_at'];
const GUEST_HISTORY_HEADERS = ['location','meal','date','count'];
const GUEST_HISTORY_META_HEADERS = ['key','value'];
const GUESTS_NEXT_WEEKS_HEADERS = ['monday_key','location','day','meal','count'];
const INGREDIENT_HEADERS = [
  'id','name','supplier_name','category','unit','supplier',
  'order_code','order_unit','order_unit_standard','order_price',
  'order_amount_grams','allergens','notes','storage_location','active'
];

// ── Row converters ──

function rowToIngredient(row) {
  return {
    id: row.id,
    name: row.name || '',
    supplierName: row.supplier_name || '',
    category: row.category || '',
    unit: row.unit || 'Grams',
    supplier: row.supplier || '',
    orderCode: row.order_code || '',
    orderUnit: row.order_unit || '',
    orderUnitStandard: row.order_unit_standard || '',
    orderPrice: row.order_price ? parseFloat(row.order_price) : null,
    orderAmountGrams: parseFloat(row.order_amount_grams) || 0,
    allergens: row.allergens || '',
    notes: row.notes || '',
    storageLocation: row.storage_location || '',
    active: row.active !== 'false',
  };
}

function ingredientToRow(ing) {
  return [
    ing.id, ing.name || '', ing.supplierName || '', ing.category || '',
    ing.unit || 'Grams', ing.supplier || '', ing.orderCode || '',
    ing.orderUnit || '', ing.orderUnitStandard || '',
    ing.orderPrice != null ? ing.orderPrice : '',
    ing.orderAmountGrams || 0, ing.allergens || '', ing.notes || '',
    ing.storageLocation || '', ing.active !== false ? 'true' : 'false',
  ];
}

// Parse Hanos "hoeveelheid" field into grams/ml, e.g. "Pak 1 liter" → 1000
function parseHanosQuantityGrams(hoeveelheid) {
  if (!hoeveelheid) return 0;
  const s = hoeveelheid.toLowerCase();
  const numMatch = s.match(/([\d.,]+)\s*(kilo(?:gram)?|gram|liter|ml|stuk)/);
  if (!numMatch) return 0;
  const num = parseFloat(numMatch[1].replace(',', '.'));
  const unit = numMatch[2];
  if (unit.startsWith('kilo')) return num * 1000;
  if (unit === 'liter') return num * 1000;
  if (unit === 'gram') return num;
  if (unit === 'ml') return num;
  if (unit === 'stuk') return 0;
  return 0;
}

function rowToCatering(row) {
  let dishes = [];
  try { if (row.dishes) dishes = JSON.parse(row.dishes); } catch (e) {}
  return {
    id: row.id,
    name: row.name || '',
    date: row.date || null,
    guestCount: parseInt(row.guest_count) || 0,
    deliveryMode: row.delivery_mode || 'pickup',
    dishes,
    logisticsNotes: row.logistics_notes || '',
  };
}

function cateringToRow(c) {
  return [
    c.id, c.name || '', c.date || '', c.guestCount || 0,
    c.deliveryMode || 'pickup', JSON.stringify(c.dishes || []),
    c.logisticsNotes || '', c.createdAt || new Date().toISOString()
  ];
}

function rowToRecipeIndex(row) {
  return {
    id: row.id,
    name: row.name || '',
    type: row.type || 'Soup',
    recipeSheetId: row.recipe_sheet_id || null,
    allergens: row.allergens ? row.allergens.split('|').filter(Boolean) : [],
    costPerServing: row.cost_per_serving || '',
    structure: row.structure || '',
    seasonality: row.seasonality || '',
    servingTemp: row.serving_temp || '',
    servingSize: parseInt(row.serving_size) || 280,
    recipeVolume: parseFloat(row.recipe_volume) || null,
    recipeIngredients: row.recipe_ingredients ? JSON.parse(row.recipe_ingredients) : null,
    createdAt: row.created_at || new Date().toISOString(),
    avgSkill: parseFloat(row.avg_skill) || 0,
    avgSpeed: parseFloat(row.avg_speed) || 0,
    avgBanger: parseFloat(row.avg_banger) || 0,
    timesServed: parseInt(row.times_served) || 0,
  };
}

function recipeIndexToRow(r) {
  return [
    r.id, r.name, r.type, r.recipeSheetId || '',
    (r.allergens || []).join('|'), r.costPerServing || '',
    r.structure || '', r.seasonality || '', r.servingTemp || '',
    r.servingSize || 280, r.recipeVolume || '',
    r.recipeIngredients ? JSON.stringify(r.recipeIngredients) : '',
    r.createdAt || new Date().toISOString(),
    r.avgSkill || 0, r.avgSpeed || 0, r.avgBanger || 0, r.timesServed || 0
  ];
}

function rowToDish(row) {
  return {
    id: row.id, name: row.name, type: row.type,
    stock: parseFloat(row.stock) || 0,
    serving: parseInt(row.serving) || 280,
    storage: row.storage || 'Gastro',
    logistics: row.logistics || 'Sering West',
    allergens: row.allergens ? row.allergens.split('|').filter(Boolean) : [],
    extraAllergens: row.extra_allergens ? row.extra_allergens.split('|').filter(Boolean) : [],
    orderFor: row.order_for === 'true',
    cookMode: row.cook_mode || 'day',
    cookDay: row.cook_day || null,
    cookDate: row.cook_date || null,
    cookConfirmed: row.cook_confirmed === 'true',
    recipeSheetId: row.recipe_sheet_id || null,
    recipeVolume: parseFloat(row.recipe_volume) || null,
    recipeIngredients: row.recipe_ingredients ? JSON.parse(row.recipe_ingredients) : null,
    parentId: row.parent_id || null,
    createdAt: row.created_at || new Date().toISOString(),
    services: []
  };
}

function dishToRow(dish) {
  return [
    dish.id, dish.name, dish.type, dish.stock, dish.serving || 280,
    dish.storage || 'Gastro', dish.logistics || 'Sering West',
    (dish.allergens || []).join('|'), (dish.extraAllergens || []).join('|'),
    dish.orderFor ? 'true' : 'false', dish.cookMode || 'day',
    dish.cookDay || '', dish.cookDate || '', dish.cookConfirmed ? 'true' : 'false',
    dish.recipeSheetId || '',
    dish.recipeVolume || '',
    dish.recipeIngredients ? JSON.stringify(dish.recipeIngredients) : '',
    dish.parentId || '', dish.createdAt || new Date().toISOString()
  ];
}

// ── Default data ──

function getDefaultGuests() {
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const west = {}, centraal = {};
  days.forEach(d => {
    west[d]     = { lunch: d==='Sat'||d==='Sun'?0:100, dinner: d==='Sat'||d==='Sun'?0:110 };
    centraal[d] = { lunch: d==='Sat'||d==='Sun'?0:80,  dinner: d==='Sat'||d==='Sun'?0:85  };
  });
  return { west, centraal };
}

// ── Database operations ──

async function dbReadAll() {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) {
    return { dishes: [], guests: getDefaultGuests(), recipeIndex: [], caterings: [], transportItems: [] };
  }
  try {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['dishes','services','guests','log','recipe_index','caterings','transport_items','guest_history','guest_history_meta','guests_next_weeks']);
    const [dishRows, serviceRows, guestRows, recipeRows, cateringRows, transportItemRows] = await Promise.all([
      readTab(sheets, CONFIG.DB_SHEET_ID, 'dishes'),
      readTab(sheets, CONFIG.DB_SHEET_ID, 'services'),
      readTab(sheets, CONFIG.DB_SHEET_ID, 'guests'),
      readTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index'),
      readTab(sheets, CONFIG.DB_SHEET_ID, 'caterings'),
      readTab(sheets, CONFIG.DB_SHEET_ID, 'transport_items'),
    ]);
    const dishes = dishRows.map(rowToDish);
    serviceRows.forEach(svcRow => {
      const dish = dishes.find(d => d.id === svcRow.dish_id);
      if (!dish) return;
      // Migration: old format stored dayIdx (0-6), new format stores ISO date string
      if (svcRow.day && svcRow.day.includes('-')) {
        dish.services.push({ loc: svcRow.location, date: svcRow.day, meal: svcRow.meal });
      } else {
        const dayIdx = parseInt(svcRow.day);
        const now = new Date();
        const todayDow = now.getDay();
        const mondayOff = todayDow === 0 ? -6 : 1 - todayDow;
        const monday = new Date(now); monday.setDate(now.getDate() + mondayOff);
        const target = new Date(monday); target.setDate(monday.getDate() + dayIdx);
        const dateStr = target.getFullYear() + '-' + String(target.getMonth() + 1).padStart(2, '0') + '-' + String(target.getDate()).padStart(2, '0');
        dish.services.push({ loc: svcRow.location, date: dateStr, meal: svcRow.meal });
      }
    });
    const guests = getDefaultGuests();
    guestRows.forEach(row => {
      if (guests[row.location] && guests[row.location][row.day]) {
        guests[row.location][row.day].lunch  = parseInt(row.lunch)  || 0;
        guests[row.location][row.day].dinner = parseInt(row.dinner) || 0;
      }
    });
    const recipeIndex = recipeRows.map(rowToRecipeIndex);
    const caterings = cateringRows.map(rowToCatering);
    const transportItems = transportItemRows.map(r => ({ id: r.id, text: r.text }));
    return { dishes, guests, recipeIndex, caterings, transportItems };
  } catch (e) {
    console.error('dbReadAll error:', e.message);
    return { dishes: [], guests: getDefaultGuests(), recipeIndex: [], caterings: [], transportItems: [] };
  }
}

async function dbWriteAll(dishes, guests, caterings, transportItems) {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return;
  try {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['dishes','services','guests','log','caterings','transport_items','guest_history','guest_history_meta','guests_next_weeks']);
    await writeTab(sheets, CONFIG.DB_SHEET_ID, 'dishes', DISH_HEADERS, dishes.map(dishToRow));

    const serviceRows = [];
    dishes.forEach(dish => {
      (dish.services || []).forEach(svc => {
        serviceRows.push([dish.id + '_' + svc.loc + '_' + svc.date + '_' + svc.meal,
          dish.id, svc.loc, svc.date, svc.meal]);
      });
    });
    await writeTab(sheets, CONFIG.DB_SHEET_ID, 'services', SERVICE_HEADERS, serviceRows);

    const guestRows = [];
    Object.entries(guests).forEach(([loc, days]) => {
      Object.entries(days).forEach(([day, meals]) => {
        guestRows.push([loc, day, meals.lunch || 0, meals.dinner || 0]);
      });
    });
    await writeTab(sheets, CONFIG.DB_SHEET_ID, 'guests', GUEST_HEADERS, guestRows);

    if (caterings && caterings.length > 0) {
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'caterings', CATERING_HEADERS, caterings.map(cateringToRow));
    }
    const TRANSPORT_ITEM_HEADERS = ['id', 'text'];
    if (transportItems && transportItems.length > 0) {
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'transport_items', TRANSPORT_ITEM_HEADERS, transportItems.map(i => [i.id, i.text]));
    }
  } catch (e) {
    console.error('dbWriteAll error:', e.message);
    throw e;
  }
}

async function dbAppendLog(userEmail, userName, action, details) {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.DB_SHEET_ID, range: 'log!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [[new Date().toISOString(), userEmail, userName, action, details]] },
    });
  } catch (e) { console.error('Log append error:', e.message); }
}

// ── Validation ──

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

// ── Write lock — serialise writes to prevent data corruption ──

let writeLock = null;
async function withWriteLock(fn) {
  while (writeLock) await writeLock;
  let resolve;
  writeLock = new Promise(r => { resolve = r; });
  try { return await fn(); }
  finally { writeLock = null; resolve(); }
}

module.exports = {
  getSheetsClient,
  readTab,
  writeTab,
  ensureTabsExist,
  DISH_HEADERS,
  SERVICE_HEADERS,
  GUEST_HEADERS,
  RECIPE_INDEX_HEADERS,
  CATERING_HEADERS,
  GUEST_HISTORY_HEADERS,
  GUEST_HISTORY_META_HEADERS,
  GUESTS_NEXT_WEEKS_HEADERS,
  INGREDIENT_HEADERS,
  rowToIngredient,
  ingredientToRow,
  parseHanosQuantityGrams,
  rowToCatering,
  cateringToRow,
  rowToRecipeIndex,
  recipeIndexToRow,
  rowToDish,
  dishToRow,
  getDefaultGuests,
  dbReadAll,
  dbWriteAll,
  dbAppendLog,
  validateDishes,
  validateGuests,
  withWriteLock,
};
