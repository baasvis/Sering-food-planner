// ─────────────────────────────────────────────────────────────────────────────
// DE SERING FOOD PLANNER — SERVER (v5 — PostgreSQL)
// ─────────────────────────────────────────────────────────────────────────────

try { require('dotenv').config(); } catch (e) { /* dotenv optional in production */ }
const express = require('express');
const fs = require('fs');
const { CONFIG, INGREDIENTS_SEED, STD_INV_SEED } = require('./lib/config');
const { prisma } = require('./lib/db');

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

// ── Seed — on first deploy, write seed data to Postgres ──

async function seedIfNeeded() {
  try {
    // Seed ingredients
    if (fs.existsSync(INGREDIENTS_SEED)) {
      const count = await prisma.ingredient.count();
      if (count === 0) {
        const seed = JSON.parse(fs.readFileSync(INGREDIENTS_SEED, 'utf8'));
        await prisma.ingredient.createMany({ data: seed });
        console.log('Seeded', seed.length, 'ingredients to Postgres');
      }
    }
    // Seed standard inventory
    if (fs.existsSync(STD_INV_SEED)) {
      const count = await prisma.standardInventory.count();
      if (count === 0) {
        const seed = JSON.parse(fs.readFileSync(STD_INV_SEED, 'utf8'));
        await prisma.standardInventory.createMany({ data: seed });
        console.log('Seeded', seed.length, 'standard inventory items to Postgres');
      }
    }
  } catch (e) {
    console.error('Seed failed:', e.message);
  }
}

// ── Start ──

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('De Sering app v5 running on port ' + PORT);
  console.log('Config check:');
  console.log('  GOOGLE_CLIENT_ID:', CONFIG.GOOGLE_CLIENT_ID ? `set (${CONFIG.GOOGLE_CLIENT_ID.slice(0, 12)}...)` : 'NOT SET — running in dev mode');
  console.log('  DATABASE_URL:', process.env.DATABASE_URL ? 'set' : 'NOT SET');
  console.log('  GOOGLE_CREDENTIALS:', CONFIG.GOOGLE_CREDENTIALS !== '{}' ? 'set' : 'NOT SET');
  console.log('  ALLOWED_EMAILS:', CONFIG.ALLOWED_EMAILS.length ? CONFIG.ALLOWED_EMAILS.join(', ') : 'NOT SET (anyone can log in)');
  seedIfNeeded();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
