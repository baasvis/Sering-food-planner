// ─────────────────────────────────────────────────────────────────────────────
// DE SERING FOOD PLANNER — SERVER (v4)
// ─────────────────────────────────────────────────────────────────────────────

try { require('dotenv').config(); } catch (e) { /* dotenv optional in production */ }
const express = require('express');
const fs = require('fs');
const { CONFIG, INGREDIENTS_SEED, INGREDIENTS_SEEDED_FLAG } = require('./lib/config');
const { getSheetsClient, ensureTabsExist, readTab, writeTab, INGREDIENT_HEADERS, ingredientToRow } = require('./lib/sheets');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// Static files
app.use(express.static('public'));

// ── Mount routes ──

const authRouter = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/api', authRouter.requireAuth);

app.use('/api/data',              require('./routes/data'));
app.use('/api',                   require('./routes/recipes'));
app.use('/api/ingredients',       require('./routes/ingredients'));
app.use('/api',                   require('./routes/guests'));
app.use('/api',                   require('./routes/inventory'));
app.use('/api/feedback',          require('./routes/feedback'));
app.use('/api/health',            require('./routes/health'));

// ── Ingredient seed — on first deploy, write seed data to Google Sheets ──

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

// ── Start ──

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('De Sering app v4 running on port ' + PORT);
  console.log('Config check:');
  console.log('  GOOGLE_CLIENT_ID:', CONFIG.GOOGLE_CLIENT_ID ? `set (${CONFIG.GOOGLE_CLIENT_ID.slice(0, 12)}...)` : 'NOT SET — running in dev mode');
  console.log('  DB_SHEET_ID:', CONFIG.DB_SHEET_ID ? 'set' : 'NOT SET');
  console.log('  GOOGLE_CREDENTIALS:', CONFIG.GOOGLE_CREDENTIALS !== '{}' ? 'set' : 'NOT SET');
  console.log('  ALLOWED_EMAILS:', CONFIG.ALLOWED_EMAILS.length ? CONFIG.ALLOWED_EMAILS.join(', ') : 'NOT SET (anyone can log in)');
  seedIngredientsIfNeeded();
});
