// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION & FILE PATHS
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');

// Persistent data directory (for server-side storage not in Google Sheets)
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const STD_INV_FILE = path.join(DATA_DIR, 'standard-inventory.json');
const STD_INV_SEED = path.join(__dirname, '..', 'seeds', 'standard-inventory.json');
const INGREDIENTS_SEED = path.join(__dirname, '..', 'seeds', 'ingredients.json');
const INGREDIENTS_SEEDED_FLAG = path.join(DATA_DIR, '.ingredients-seeded');
const PREP_CHECKLIST_FILE = path.join(DATA_DIR, 'prep-checklist.json');

// Seed from default inventory on first deploy if no data file exists yet
if (!fs.existsSync(STD_INV_FILE) && fs.existsSync(STD_INV_SEED)) {
  fs.copyFileSync(STD_INV_SEED, STD_INV_FILE);
  console.log('Standard inventory seeded from seeds/standard-inventory.json');
}

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
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  ALLOWED_EMAILS: (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
};

// Cookie options: secure when behind HTTPS (production), lax otherwise (dev)
function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.RAILWAY_ENVIRONMENT === 'production' || !!process.env.RAILWAY_PUBLIC_DOMAIN,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

module.exports = {
  CONFIG,
  DATA_DIR,
  STD_INV_FILE,
  STD_INV_SEED,
  INGREDIENTS_SEED,
  INGREDIENTS_SEEDED_FLAG,
  PREP_CHECKLIST_FILE,
  cookieOpts,
  cleanSheetId,
};
