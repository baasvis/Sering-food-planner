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

// Persistent data directory (for server-side storage not in Google Sheets)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STD_INV_FILE = path.join(DATA_DIR, 'standard-inventory.json');
const GUEST_HIST_FILE = path.join(DATA_DIR, 'guest-history.json');
const GUEST_NEXT_FILE = path.join(DATA_DIR, 'guests-next-weeks.json');
const STD_INV_SEED = path.join(__dirname, 'seeds', 'standard-inventory.json');
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
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['dishes','services','guests','log','recipe_index','caterings','transport_items']);
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
      if (dish) dish.services.push({ loc: svcRow.location, day: parseInt(svcRow.day), meal: svcRow.meal });
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
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['dishes','services','guests','log','caterings','transport_items']);
    await writeTab(sheets, CONFIG.DB_SHEET_ID, 'dishes', DISH_HEADERS, dishes.map(dishToRow));

    const serviceRows = [];
    dishes.forEach(dish => {
      (dish.services || []).forEach(svc => {
        serviceRows.push([dish.id + '_' + svc.loc + '_' + svc.day + '_' + svc.meal,
          dish.id, svc.loc, svc.day, svc.meal]);
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
      if (typeof svc.day !== 'number' || svc.day < 0 || svc.day > 6) return `Dish ${i}: invalid service day`;
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

app.get('/api/ingredients', async (req, res) => {
  const sheets = getSheetsClient();
  if (!sheets) return res.status(503).json({ error: 'Google Sheets not configured' });
  if (!CONFIG.INGREDIENT_DB_SHEET_ID) return res.json({ error: 'INGREDIENT_DB_SHEET_ID not set', items: [] });
  try {
    // First get the sheet metadata to find the correct tab name
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: CONFIG.INGREDIENT_DB_SHEET_ID, fields: 'sheets.properties(title,sheetId)',
    });
    const sheets_meta = meta.data.sheets;
    console.log('Ingredient DB tabs:', sheets_meta.map(s => `${s.properties.title} (gid=${s.properties.sheetId})`));
    // Use the tab matching INGREDIENT_DB_GID if set, otherwise first tab
    const targetGid = CONFIG.INGREDIENT_DB_GID ? parseInt(CONFIG.INGREDIENT_DB_GID) : null;
    const matchedTab = targetGid != null
      ? sheets_meta.find(s => s.properties.sheetId === targetGid)
      : null;
    const tabName = (matchedTab || sheets_meta[0])?.properties?.title || 'Sheet1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.INGREDIENT_DB_SHEET_ID, range: `'${tabName}'!B3:R2000`,
    });
    const allRows = response.data.values || [];
    console.log('Ingredient DB raw rows:', allRows.length);
    const rows = allRows.slice(1).filter(r => r[0]); // skip header row
    console.log('Ingredient DB filtered rows:', rows.length);
    if (rows.length > 0) console.log('First ingredient:', rows[0][0], '| orderCode:', rows[0][5]);
    res.json(rows.map(r => ({
      name: r[0] || '',
      unit: r[1] || 'g',
      source: r[2] || '',
      costPer100: r[3] || '',
      orderType: r[4] || '',
      orderCode: r[5] || '',
      actualUnit: r[6] || '',
      orderAmount: parseFloat(r[7]) || 0,
      notes: r[8] || '',
      orderPrice: r[9] || '',
      unitRecalc: parseFloat(r[10]) || 0,
      allergens: r[13] || '',
      storageLocation: r[16] || '',
    })));
  } catch (e) {
    console.error('Ingredient DB error:', e.message);
    // Return the error as data so frontend can display it
    res.json({ error: e.message, items: [] });
  }
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

// ── Guest history (aggregated Tebi data for predictions) ─────────────────────

app.get('/api/guest-history', (req, res) => {
  try {
    const data = fs.existsSync(GUEST_HIST_FILE)
      ? JSON.parse(fs.readFileSync(GUEST_HIST_FILE, 'utf8'))
      : {};
    res.json(data);
  } catch (e) {
    res.json({});
  }
});

app.post('/api/guest-history', (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    const existing = fs.existsSync(GUEST_HIST_FILE)
      ? JSON.parse(fs.readFileSync(GUEST_HIST_FILE, 'utf8'))
      : {};
    // Deep merge: for each location → each meal type → merge date keys
    for (const loc of ['west', 'centraal']) {
      if (!incoming[loc]) continue;
      if (!existing[loc]) existing[loc] = {};
      for (const meal of ['lunch', 'dinner', 'staff']) {
        if (!incoming[loc][meal]) continue;
        if (!existing[loc][meal]) existing[loc][meal] = {};
        Object.assign(existing[loc][meal], incoming[loc][meal]);
      }
    }
    if (incoming.deviceMap) {
      existing.deviceMap = { ...(existing.deviceMap || {}), ...incoming.deviceMap };
    }
    existing.lastUpdated = new Date().toISOString();
    fs.writeFileSync(GUEST_HIST_FILE, JSON.stringify(existing, null, 2));
    res.json({ ok: true, dates: Object.keys(existing.west?.lunch || {}).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Guests next weeks (editable future week data) ────────────────────────────

app.get('/api/guests-next-weeks', (req, res) => {
  try {
    const data = fs.existsSync(GUEST_NEXT_FILE)
      ? JSON.parse(fs.readFileSync(GUEST_NEXT_FILE, 'utf8'))
      : {};
    res.json(data);
  } catch (e) {
    res.json({});
  }
});

app.post('/api/guests-next-weeks', (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    fs.writeFileSync(GUEST_NEXT_FILE, JSON.stringify(data, null, 2));
    res.json({ ok: true });
  } catch (e) {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('De Sering app v4 running on port ' + PORT);
  console.log('Config check:');
  console.log('  GOOGLE_CLIENT_ID:', CONFIG.GOOGLE_CLIENT_ID ? `set (${CONFIG.GOOGLE_CLIENT_ID.slice(0, 12)}...)` : 'NOT SET — running in dev mode');
  console.log('  DB_SHEET_ID:', CONFIG.DB_SHEET_ID ? 'set' : 'NOT SET');
  console.log('  GOOGLE_CREDENTIALS:', CONFIG.GOOGLE_CREDENTIALS !== '{}' ? 'set' : 'NOT SET');
  console.log('  ALLOWED_EMAILS:', CONFIG.ALLOWED_EMAILS.length ? CONFIG.ALLOWED_EMAILS.join(', ') : 'NOT SET (anyone can log in)');
});
