// ─────────────────────────────────────────────────────────────────────────────
// DE SERING FOOD PLANNER — SERVER (v4)
// ─────────────────────────────────────────────────────────────────────────────
// Changes from v3:
//   - Google Sign-In authentication (only approved emails can access)
//   - Server-side data validation on POST
//   - Activity log (who changed what, when)
//   - Write lock to prevent concurrent overwrites
//   - Sheet ID sanitization on recipe endpoint
// ─────────────────────────────────────────────────────────────────────────────

try { require('dotenv').config(); } catch (e) { /* dotenv optional in production */ }
const express = require('express');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const XLSX = require('xlsx');

// File upload config (memory storage for XLSX parsing)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Persistent data directory (for server-side storage not in Google Sheets)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STD_INV_FILE = path.join(DATA_DIR, 'standard-inventory.json');
const STD_INV_SEED = path.join(__dirname, 'seeds', 'standard-inventory.json');
const INGREDIENTS_SEED = path.join(__dirname, 'seeds', 'ingredients.json');
const INGREDIENTS_SEEDED_FLAG = path.join(DATA_DIR, '.ingredients-seeded');
const PREP_CHECKLIST_FILE = path.join(DATA_DIR, 'prep-checklist.json');
// Seed from default inventory on first deploy if no data file exists yet
if (!fs.existsSync(STD_INV_FILE) && fs.existsSync(STD_INV_SEED)) {
  fs.copyFileSync(STD_INV_SEED, STD_INV_FILE);
  console.log('Standard inventory seeded from seeds/standard-inventory.json');
}

const app = express();
app.set('trust proxy', 1); // Trust Railway's proxy so secure cookies work
app.use(express.json({ limit: '2mb' }));

// Cookie options: secure when behind HTTPS (production), lax otherwise (dev)
function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.RAILWAY_ENVIRONMENT === 'production' || !!process.env.RAILWAY_PUBLIC_DOMAIN,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// Set these as environment variables (e.g. in Replit Secrets, .env, or hosting panel)
// ─────────────────────────────────────────────────────────────────────────────

// Extract just the sheet ID if a full URL was pasted
function cleanSheetId(val) {
  if (!val) return '';
  const m = val.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return val.replace(/\/.*$/, '').trim();
}

const CONFIG = {
  DB_SHEET_ID: cleanSheetId(process.env.DB_SHEET_ID || ''),
  INGREDIENT_DB_SHEET_ID: cleanSheetId(process.env.INGREDIENT_DB_SHEET_ID || '1yrYRECESZf6kP5GHwDDR9CmxBtm5G9-gRCPUJqgkzQc'),
  INGREDIENT_DB_GID: process.env.INGREDIENT_DB_GID || '1737213788',
  GOOGLE_CREDENTIALS: process.env.GOOGLE_CREDENTIALS || '{}',

  // Google Sign-In: your Google Cloud OAuth client ID
  // Create at https://console.cloud.google.com/apis/credentials
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',

  // Comma-separated list of allowed email addresses
  // e.g. "chef@desering.nl,sous@desering.nl,volunteer1@gmail.com"
  ALLOWED_EMAILS: (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION
// ─────────────────────────────────────────────────────────────────────────────

const authClient = new OAuth2Client(CONFIG.GOOGLE_CLIENT_ID);
const sessions = new Map(); // sessionId → { email, name, picture }

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

async function verifyGoogleToken(idToken) {
  const ticket = await authClient.verifyIdToken({
    idToken,
    audience: CONFIG.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  return {
    email: payload.email.toLowerCase(),
    name: payload.name || payload.email,
    picture: payload.picture || null,
  };
}

function parseCookie(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

function getSessionUser(req) {
  const sessionId = parseCookie(req.headers.cookie || '', 'session');
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

// Auth: exchange Google ID token for session cookie
app.post('/api/auth/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  // Dev mode: no GOOGLE_CLIENT_ID configured
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    const sessionId = generateSessionId();
    sessions.set(sessionId, { email: 'dev@local', name: 'Dev Mode', picture: null });
    res.cookie('session', sessionId, cookieOpts());
    return res.json({ ok: true, user: { email: 'dev@local', name: 'Dev Mode' } });
  }

  try {
    const user = await verifyGoogleToken(idToken);
    if (CONFIG.ALLOWED_EMAILS.length > 0 && !CONFIG.ALLOWED_EMAILS.includes(user.email)) {
      console.warn(`Login denied for ${user.email} — not in ALLOWED_EMAILS`);
      return res.status(403).json({ error: 'not_allowed', message: 'Je account heeft geen toegang. Vraag je teamleider om je e-mail toe te voegen.' });
    }
    const sessionId = generateSessionId();
    sessions.set(sessionId, user);
    res.cookie('session', sessionId, cookieOpts());
    return res.json({ ok: true, user: { email: user.email, name: user.name, picture: user.picture } });
  } catch (e) {
    console.error('Auth error:', e.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const sessionId = parseCookie(req.headers.cookie || '', 'session');
  if (sessionId) sessions.delete(sessionId);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user });
});

// Protect all /api/* except auth + health
function requireAuth(req, res, next) {
  if (req.path.startsWith('/auth/') || req.path === '/health') return next();
  if (!CONFIG.GOOGLE_CLIENT_ID) return next(); // dev mode
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}
app.use('/api', requireAuth);

// Static files
app.use(express.static('public'));

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SHEETS CLIENT
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// DATA LAYER
// ─────────────────────────────────────────────────────────────────────────────

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

// Parse Hanos "hoeveelheid" field into grams/ml, e.g. "Pak 1 liter" → 1000, "Zak 5 kilogram" → 5000
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
  if (unit === 'stuk') return 0; // can't convert pieces to grams
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

function getDefaultGuests() {
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const west = {}, centraal = {};
  days.forEach(d => {
    west[d]     = { lunch: d==='Sat'||d==='Sun'?0:100, dinner: d==='Sat'||d==='Sun'?0:110 };
    centraal[d] = { lunch: d==='Sat'||d==='Sun'?0:80,  dinner: d==='Sat'||d==='Sun'?0:85  };
  });
  return { west, centraal };
}

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
        // New format: date string like "2026-03-23"
        dish.services.push({ loc: svcRow.location, date: svcRow.day, meal: svcRow.meal });
      } else {
        // Old format: dayIdx (0=Mon..6=Sun) — convert to this week's date
        const dayIdx = parseInt(svcRow.day);
        const now = new Date();
        const todayDow = now.getDay(); // 0=Sun
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

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// WRITE LOCK — serialise writes to prevent data corruption
// ─────────────────────────────────────────────────────────────────────────────

let writeLock = null;
async function withWriteLock(fn) {
  while (writeLock) await writeLock;
  let resolve;
  writeLock = new Promise(r => { resolve = r; });
  try { return await fn(); }
  finally { writeLock = null; resolve(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/data', async (req, res) => {
  try { res.json(await dbReadAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data', async (req, res) => {
  try {
    const dishes = req.body.dishes || [];
    const guests = req.body.guests || getDefaultGuests();
    const caterings = req.body.caterings || [];
    const transportItems = req.body.transportItems || [];

    const dishErr = validateDishes(dishes);
    if (dishErr) return res.status(400).json({ error: dishErr });
    const guestErr = validateGuests(guests);
    if (guestErr) return res.status(400).json({ error: guestErr });

    await withWriteLock(() => dbWriteAll(dishes, guests, caterings, transportItems));

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'save', `${dishes.length} dishes`);

    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recipe-index', async (req, res) => {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return res.json([]);
  try {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['recipe_index']);
    const rows = await readTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index');
    res.json(rows.map(rowToRecipeIndex));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/recipe-index', async (req, res) => {
  const recipe = req.body;
  if (!recipe || !recipe.id || !recipe.name) return res.status(400).json({ error: 'id and name required' });
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['recipe_index']);
      const existing = await readTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index');
      const all = existing.map(rowToRecipeIndex);
      const idx = all.findIndex(r => r.id === recipe.id);
      if (idx >= 0) all[idx] = recipe;
      else all.push(recipe);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index', RECIPE_INDEX_HEADERS, all.map(recipeIndexToRow));
    });
    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'recipe-index', `saved "${recipe.name}"`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/recipe-index/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      const existing = await readTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index');
      const all = existing.map(rowToRecipeIndex).filter(r => r.id !== id);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index', RECIPE_INDEX_HEADERS, all.map(recipeIndexToRow));
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recipe', async (req, res) => {
  const { sheetId } = req.query;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(sheetId)) return res.status(400).json({ error: 'Invalid sheetId format' });

  const sheets = getSheetsClient();
  if (!sheets) return res.status(503).json({ error: 'Google Sheets not configured' });
  try {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId, ranges: ['C1','B3','D3','F3','H3','K2','K4','O3','O4','J6:N40','X6:X40','K6:K40'],
    });
    const vals = response.data.valueRanges;
    const dishName    = vals[0].values?.[0]?.[0] || '';
    const serving     = parseFloat((vals[1].values?.[0]?.[0]||'280').toString().replace(',','.')) || 280;
    const allergens   = (vals[2].values?.[0]?.[0]||'').split(',').map(s=>s.trim()).filter(Boolean);
    const servingTemp = vals[3].values?.[0]?.[0] || '';
    const structure   = vals[4].values?.[0]?.[0] || '';
    const dishType    = vals[5].values?.[0]?.[0] || '';
    const recipeVol   = parseFloat((vals[6].values?.[0]?.[0]||'0').toString().replace(',','.')) || 0;
    const seasonality = vals[7].values?.[0]?.[0] || '';
    const costPerServing = vals[8].values?.[0]?.[0] || '';
    const ingRows     = vals[9].values || [];
    const sourceRows  = vals[10].values || [];
    const unitRows    = vals[11].values || [];
    const ingredients = [];
    ingRows.forEach((row, i) => {
      // row[0]=name(J), row[1]=measurement(K), row[2]=amount(L), row[3]=amount_after_cooking(M), row[4]=cost(N)
      // Skip rows without a name, or without a numeric amount in column L
      if (!row[0] || !row[2]) return;
      const rawAmt = parseFloat(String(row[2]).replace(',','.'));
      if (!rawAmt || rawAmt <= 0) return;
      // Skip instruction/note rows: if name is very long or amount column has no number
      if (row[0].length > 80) return;
      const afterCooking = row[3] ? parseFloat(String(row[3]).replace(',','.')) : null;
      const amount = (afterCooking && afterCooking > 0) ? afterCooking : rawAmt;
      const unit = (unitRows[i] && unitRows[i][0]) || 'Grams';
      ingredients.push({
        name: row[0],
        amount,
        unit,
        source: (sourceRows[i] && sourceRows[i][0]) || '',
      });
    });
    res.json({ dishName, serving, allergens, servingTemp, structure, dishType, recipeVolume: recipeVol, seasonality, costPerServing, ingredients });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// INGREDIENT DATABASE (stored in 'ingredients' tab of main DB sheet)
// ─────────────────────────────────────────────────────────────────────────────

// Helper: load ingredients from Sheets or fall back to seed file
async function loadIngredients() {
  const sheets = getSheetsClient();
  if (sheets && CONFIG.DB_SHEET_ID) {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['ingredients']);
    const rows = await readTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients');
    if (rows.length > 0) return rows.map(rowToIngredient);
  }
  // Fallback: load from seed file (dev mode or before first Sheets write)
  if (fs.existsSync(INGREDIENTS_SEED)) {
    return JSON.parse(fs.readFileSync(INGREDIENTS_SEED, 'utf8'));
  }
  return [];
}

app.get('/api/ingredients', async (req, res) => {
  try {
    const ingredients = await loadIngredients();
    // Map to format expected by frontend (backward-compatible with old ingredient DB)
    res.json(ingredients.map(ing => ({
      id: ing.id,
      name: ing.name,
      supplierName: ing.supplierName,
      category: ing.category,
      unit: ing.unit,
      source: ing.supplier,
      orderCode: ing.orderCode,
      orderUnit: ing.orderUnit,
      orderUnitStandard: ing.orderUnitStandard,
      orderPrice: ing.orderPrice || '',
      orderAmount: ing.orderAmountGrams,
      unitRecalc: ing.orderAmountGrams,
      allergens: ing.allergens,
      notes: ing.notes,
      storageLocation: ing.storageLocation,
      active: ing.active,
    })));
  } catch (e) {
    console.error('Ingredient DB error:', e.message);
    res.json({ error: e.message, items: [] });
  }
});

// Full ingredient list (for the ingredient DB editor tab)
app.get('/api/ingredients/full', async (req, res) => {
  try {
    const ingredients = await loadIngredients();
    res.json(ingredients);
  } catch (e) {
    console.error('Ingredient DB error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bulk save all ingredients
app.post('/api/ingredients', async (req, res) => {
  const ingredients = req.body;
  if (!Array.isArray(ingredients)) return res.status(400).json({ error: 'Expected array' });
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['ingredients']);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients', INGREDIENT_HEADERS, ingredients.map(ingredientToRow));
    });
    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'ingredients-bulk', `saved ${ingredients.length} ingredients`);
    res.json({ ok: true, count: ingredients.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload and parse Hanos XLSX — returns parsed products for review
// NOTE: specific routes like /upload-supplier and /migrate MUST come before /:id
app.post('/api/ingredients/upload-supplier', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets['prices'] || wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (data.length < 2) return res.json([]);
    const headers = data[0];

    // Find column indices
    const col = (name) => headers.indexOf(name);
    const titleIdx = col('title');
    const codeIdx = col('artikelnummer');
    const priceIdx = col('stukprijs');
    const qtyIdx = col('hoeveelheid');
    const stdQtyIdx = col('hoeveelheid_standaard');
    const catIdx = col('categorie');
    const subCatIdx = col('subcategorie');

    // Find month columns for recent order detection
    const monthCols = headers.map((h, i) => ({ name: h, idx: i }))
      .filter(c => /^[A-Z][a-z]{2}-\d{2}$/.test(c.name));
    const last6 = monthCols.slice(-6);

    const products = data.slice(1).filter(r => r[titleIdx]).map(r => {
      const recentOrders = last6.reduce((sum, mc) => sum + (parseFloat(r[mc.idx]) || 0), 0);
      return {
        title: r[titleIdx] || '',
        orderCode: String(r[codeIdx] || ''),
        price: r[priceIdx] != null ? parseFloat(r[priceIdx]) : null,
        orderUnit: r[qtyIdx] || '',
        orderUnitStandard: r[stdQtyIdx] || '',
        category: r[catIdx] || '',
        subcategory: r[subCatIdx] || '',
        orderAmountGrams: parseHanosQuantityGrams(r[qtyIdx] || ''),
        recentOrders: Math.round(recentOrders * 10) / 10,
      };
    });

    res.json(products);
  } catch (e) {
    console.error('XLSX parse error:', e.message);
    res.status(500).json({ error: 'Failed to parse file: ' + e.message });
  }
});

// One-time migration: merge old CSV ingredient DB + Hanos XLSX
app.post('/api/ingredients/migrate', upload.fields([
  { name: 'oldCsv', maxCount: 1 },
  { name: 'hanosXlsx', maxCount: 1 },
]), async (req, res) => {
  try {
    const sheets = getSheetsClient();
    if (!sheets || !CONFIG.DB_SHEET_ID) return res.status(503).json({ error: 'Sheets not configured' });

    // Parse old CSV
    const oldIngredients = [];
    if (req.files.oldCsv && req.files.oldCsv[0]) {
      const csvText = req.files.oldCsv[0].buffer.toString('utf8');
      const lines = csvText.split('\n');
      // Skip first 3 header lines (breda line, blank line, actual headers)
      lines.slice(3).forEach(line => {
        // Simple CSV parse (handles basic cases)
        const cols = line.split(',');
        const name = (cols[1] || '').trim();
        if (!name || name === 'Name') return;
        oldIngredients.push({
          category: (cols[0] || '').trim(),
          name,
          unit: (cols[2] || 'Grams').trim(),
          source: (cols[3] || '').trim(),
          orderCode: (cols[6] || '').trim(),
          notes: (cols[23] || '').trim(),
          storageLocation: (cols[15] || '').trim(),
          allergens: (cols[14] || '').trim(),
        });
      });
    }

    // Parse Hanos XLSX
    const hanosByCode = {};
    if (req.files.hanosXlsx && req.files.hanosXlsx[0]) {
      const wb = XLSX.read(req.files.hanosXlsx[0].buffer, { type: 'buffer' });
      const ws = wb.Sheets['prices'] || wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      data.slice(1).forEach(r => {
        const code = String(r[1] || '');
        if (code) {
          hanosByCode[code] = {
            title: r[0] || '',
            price: r[3] != null ? parseFloat(r[3]) : null,
            orderUnit: r[4] || '',
            orderUnitStandard: r[5] || '',
            category: r[18] || '',
            orderAmountGrams: parseHanosQuantityGrams(r[4] || ''),
          };
        }
      });
    }

    // Merge: old ingredients enriched with Hanos data
    const merged = [];
    const usedCodes = new Set();

    oldIngredients.forEach(old => {
      const id = crypto.randomUUID();
      const code = old.orderCode.replace(/[^0-9]/g, '');
      const hanos = code ? hanosByCode[code] : null;

      merged.push({
        id,
        name: old.name,
        supplierName: hanos ? hanos.title : '',
        category: old.category || '',
        unit: old.unit || 'Grams',
        supplier: old.source || (hanos ? 'Hanos' : ''),
        orderCode: code || '',
        orderUnit: hanos ? hanos.orderUnit : '',
        orderUnitStandard: hanos ? hanos.orderUnitStandard : '',
        orderPrice: hanos ? hanos.price : null,
        orderAmountGrams: hanos ? hanos.orderAmountGrams : 0,
        allergens: old.allergens || '',
        notes: old.notes || '',
        storageLocation: old.storageLocation || '',
        active: true,
      });

      if (code) usedCodes.add(code);
    });

    // Write to Google Sheets
    await withWriteLock(async () => {
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['ingredients']);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients', INGREDIENT_HEADERS, merged.map(ingredientToRow));
    });

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'ingredient-migration',
      `Migrated ${merged.length} ingredients (${Object.keys(hanosByCode).length} Hanos products available, ${usedCodes.size} matched)`);

    res.json({
      ok: true,
      total: merged.length,
      hanosMatched: usedCodes.size,
      hanosAvailable: Object.keys(hanosByCode).length,
    });
  } catch (e) {
    console.error('Migration error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Save single ingredient (create or update) — must be after specific routes
app.post('/api/ingredients/:id', async (req, res) => {
  const ingredient = req.body;
  if (!ingredient || !ingredient.name) return res.status(400).json({ error: 'name required' });
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['ingredients']);
      const existing = await readTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients');
      const all = existing.map(rowToIngredient);
      const idx = all.findIndex(i => i.id === req.params.id);
      if (idx >= 0) {
        all[idx] = { ...all[idx], ...ingredient, id: req.params.id };
      } else {
        all.push({ ...ingredient, id: req.params.id });
      }
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients', INGREDIENT_HEADERS, all.map(ingredientToRow));
    });
    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'ingredient', `saved "${ingredient.name}"`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete ingredient
app.delete('/api/ingredients/:id', async (req, res) => {
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      const existing = await readTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients');
      const all = existing.map(rowToIngredient).filter(i => i.id !== req.params.id);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients', INGREDIENT_HEADERS, all.map(ingredientToRow));
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/log', async (req, res) => {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return res.json([]);
  try {
    const rows = await readTab(sheets, CONFIG.DB_SHEET_ID, 'log');
    res.json(rows.slice(-50).reverse());
  } catch (e) { res.json([]); }
});

// ─────────────────────────────────────────────────────────────────────────────
// STANDARD INVENTORY (server-side JSON storage)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/standard-inventory', (req, res) => {
  try {
    const items = fs.existsSync(STD_INV_FILE) ? JSON.parse(fs.readFileSync(STD_INV_FILE, 'utf8')) : [];
    res.json(items);
  } catch (e) {
    res.json([]);
  }
});

app.post('/api/standard-inventory', (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected array' });
  try {
    fs.writeFileSync(STD_INV_FILE, JSON.stringify(items, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Prep Checklist (server-side JSON, keyed by loc+date, auto-expires) ────────

function loadPrepChecklistFile() {
  try {
    if (fs.existsSync(PREP_CHECKLIST_FILE))
      return JSON.parse(fs.readFileSync(PREP_CHECKLIST_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function savePrepChecklistFile(data) {
  // Auto-expire entries older than 3 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD
  for (const key of Object.keys(data)) {
    // key format: "west-YYYY-MM-DD"
    const dash = key.indexOf('-');
    const isoDate = key.slice(dash + 1);
    if (isoDate < cutoffStr) delete data[key];
  }
  fs.writeFileSync(PREP_CHECKLIST_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/prep-checklist', (req, res) => {
  const { loc, date } = req.query;
  if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
  const data = loadPrepChecklistFile();
  res.json(data[`${loc}-${date}`] || []);
});

app.post('/api/prep-checklist', (req, res) => {
  const { loc, date, checked } = req.body;
  if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
  const data = loadPrepChecklistFile();
  data[`${loc}-${date}`] = Array.isArray(checked) ? checked : [];
  savePrepChecklistFile(data);
  res.json({ ok: true });
});

// ── Guest history (aggregated Tebi data for predictions) — stored in Google Sheets ──

// Reconstruct nested JSON from flat guest_history + guest_history_meta rows
function guestHistoryRowsToJson(histRows, metaRows) {
  const result = {};
  for (const row of histRows) {
    const loc = row.location;
    const meal = row.meal;
    if (!result[loc]) result[loc] = {};
    if (!result[loc][meal]) result[loc][meal] = {};
    result[loc][meal][row.date] = parseInt(row.count) || 0;
  }
  for (const row of metaRows) {
    if (row.key === 'deviceMap') {
      try { result.deviceMap = JSON.parse(row.value); } catch (e) { result.deviceMap = {}; }
    } else if (row.key === 'lastUpdated') {
      result.lastUpdated = row.value;
    }
  }
  return result;
}

// Flatten nested guest history JSON to rows for Google Sheets
function guestHistoryJsonToRows(data) {
  const rows = [];
  for (const loc of ['west', 'centraal']) {
    if (!data[loc]) continue;
    for (const meal of ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner']) {
      if (!data[loc][meal]) continue;
      for (const [date, count] of Object.entries(data[loc][meal])) {
        rows.push([loc, meal, date, count]);
      }
    }
  }
  return rows;
}

app.get('/api/guest-history', async (req, res) => {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return res.json({});
  try {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['guest_history', 'guest_history_meta']);
    const [histRows, metaRows] = await Promise.all([
      readTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history'),
      readTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history_meta'),
    ]);
    res.json(guestHistoryRowsToJson(histRows, metaRows));
  } catch (e) {
    console.error('guest-history read error:', e.message);
    res.json({});
  }
});

app.post('/api/guest-history', async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['guest_history', 'guest_history_meta']);

      // Read existing data and merge
      const [existingHistRows, existingMetaRows] = await Promise.all([
        readTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history'),
        readTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history_meta'),
      ]);
      const existing = guestHistoryRowsToJson(existingHistRows, existingMetaRows);

      // Deep merge incoming data
      for (const loc of ['west', 'centraal']) {
        if (!incoming[loc]) continue;
        if (!existing[loc]) existing[loc] = {};
        for (const meal of ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner']) {
          if (!incoming[loc][meal]) continue;
          if (!existing[loc][meal]) existing[loc][meal] = {};
          Object.assign(existing[loc][meal], incoming[loc][meal]);
        }
      }
      if (incoming.deviceMap) {
        existing.deviceMap = { ...(existing.deviceMap || {}), ...incoming.deviceMap };
      }
      existing.lastUpdated = new Date().toISOString();

      // Write back
      const histDataRows = guestHistoryJsonToRows(existing);
      const metaDataRows = [
        ['deviceMap', JSON.stringify(existing.deviceMap || {})],
        ['lastUpdated', existing.lastUpdated],
      ];
      await Promise.all([
        writeTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history', GUEST_HISTORY_HEADERS, histDataRows),
        writeTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history_meta', GUEST_HISTORY_META_HEADERS, metaDataRows),
      ]);
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('guest-history write error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Guests next weeks (editable future week data) — stored in Google Sheets ──

// Reconstruct nested JSON from flat guests_next_weeks rows
function guestsNextWeeksRowsToJson(rows) {
  const result = {};
  for (const row of rows) {
    const mk = row.monday_key;
    if (!result[mk]) result[mk] = {};
    if (!result[mk][row.location]) result[mk][row.location] = {};
    if (!result[mk][row.location][row.day]) result[mk][row.location][row.day] = {};
    result[mk][row.location][row.day][row.meal] = parseInt(row.count) || 0;
  }
  return result;
}

// Flatten nested next-weeks JSON to rows for Google Sheets
function guestsNextWeeksJsonToRows(data) {
  const rows = [];
  for (const [mondayKey, locations] of Object.entries(data)) {
    if (typeof locations !== 'object') continue;
    for (const [loc, days] of Object.entries(locations)) {
      if (typeof days !== 'object') continue;
      for (const [day, meals] of Object.entries(days)) {
        if (typeof meals !== 'object') continue;
        for (const [meal, count] of Object.entries(meals)) {
          rows.push([mondayKey, loc, day, meal, count]);
        }
      }
    }
  }
  return rows;
}

app.get('/api/guests-next-weeks', async (req, res) => {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return res.json({});
  try {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['guests_next_weeks']);
    const rows = await readTab(sheets, CONFIG.DB_SHEET_ID, 'guests_next_weeks');
    res.json(guestsNextWeeksRowsToJson(rows));
  } catch (e) {
    console.error('guests-next-weeks read error:', e.message);
    res.json({});
  }
});

app.post('/api/guests-next-weeks', async (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['guests_next_weeks']);
      const rows = guestsNextWeeksJsonToRows(data);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'guests_next_weeks', GUESTS_NEXT_WEEKS_HEADERS, rows);
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('guests-next-weeks write error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  let creds = {};
  try { creds = JSON.parse(CONFIG.GOOGLE_CREDENTIALS); } catch (e) {}
  res.json({
    status: 'ok',
    sheetsConfigured: !!creds.client_email,
    dbSheetConfigured: !!CONFIG.DB_SHEET_ID,
    authConfigured: !!CONFIG.GOOGLE_CLIENT_ID,
    googleClientId: CONFIG.GOOGLE_CLIENT_ID || null,
    allowedEmails: CONFIG.ALLOWED_EMAILS.length,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEEDBACK
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/feedback', requireAuth, async (req, res) => {
  const { type, text, screen, user, timestamp, userAgent } = req.body;
  if (!text) return res.status(400).json({ error: 'Feedback text required' });

  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return res.status(503).json({ error: 'Google Sheets not configured' });

  try {
    // Ensure 'feedback' tab exists
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: CONFIG.DB_SHEET_ID, fields: 'sheets.properties.title',
    });
    const tabs = meta.data.sheets.map(s => s.properties.title);
    if (!tabs.includes('feedback')) {
      // Create the tab with headers
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: CONFIG.DB_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'feedback' } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: CONFIG.DB_SHEET_ID,
        range: 'feedback!A1:F1',
        valueInputOption: 'RAW',
        requestBody: { values: [['Timestamp', 'User', 'Type', 'Screen', 'Feedback', 'User Agent']] },
      });
    }

    // Append the feedback
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.DB_SHEET_ID,
      range: 'feedback!A:F',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[timestamp || new Date().toISOString(), user || 'anonymous', type || 'general', screen || '', text, userAgent || '']],
      },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('Feedback save error:', e.message);
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INGREDIENT SEED — on first deploy, write seed data to Google Sheets
// ─────────────────────────────────────────────────────────────────────────────
async function seedIngredientsIfNeeded() {
  if (fs.existsSync(INGREDIENTS_SEEDED_FLAG)) return;
  if (!fs.existsSync(INGREDIENTS_SEED)) return;
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return;
  try {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['ingredients']);
    const existing = await readTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients');
    if (existing.length > 0) {
      console.log('Ingredients tab already has', existing.length, 'rows — skipping seed');
      fs.writeFileSync(INGREDIENTS_SEEDED_FLAG, new Date().toISOString());
      return;
    }
    const seed = JSON.parse(fs.readFileSync(INGREDIENTS_SEED, 'utf8'));
    console.log('Seeding', seed.length, 'ingredients to Google Sheets...');
    await writeTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients', INGREDIENT_HEADERS, seed.map(ingredientToRow));
    fs.writeFileSync(INGREDIENTS_SEEDED_FLAG, new Date().toISOString());
    console.log('Ingredient seed complete:', seed.length, 'ingredients written');
  } catch (e) {
    console.error('Ingredient seed failed:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('De Sering app v4 running on port ' + PORT);
  console.log('Config check:');
  console.log('  GOOGLE_CLIENT_ID:', CONFIG.GOOGLE_CLIENT_ID ? `set (${CONFIG.GOOGLE_CLIENT_ID.slice(0, 12)}...)` : 'NOT SET — running in dev mode');
  console.log('  DB_SHEET_ID:', CONFIG.DB_SHEET_ID ? 'set' : 'NOT SET');
  console.log('  GOOGLE_CREDENTIALS:', CONFIG.GOOGLE_CREDENTIALS !== '{}' ? 'set' : 'NOT SET');
  console.log('  ALLOWED_EMAILS:', CONFIG.ALLOWED_EMAILS.length ? CONFIG.ALLOWED_EMAILS.join(', ') : 'NOT SET (anyone can log in)');
  // Seed ingredients on first deploy
  seedIngredientsIfNeeded();
});
