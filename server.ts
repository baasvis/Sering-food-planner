// ─────────────────────────────────────────────────────────────────────────────
// DE SERING FOOD PLANNER — SERVER (v5 — PostgreSQL)
// ─────────────────────────────────────────────────────────────────────────────

try { require('dotenv').config(); } catch (_e) { /* dotenv optional in production */ }

import fs from 'fs';
import { CONFIG, INGREDIENTS_SEED, STD_INV_SEED, errMsg } from './lib/config';
import { prisma } from './lib/db';
import app from './app';

// ── Seed — on first deploy, write seed data to Postgres ──

async function seedIfNeeded() {
  try {
    if (fs.existsSync(INGREDIENTS_SEED)) {
      const count = await prisma.ingredient.count();
      if (count === 0) {
        const seed = JSON.parse(fs.readFileSync(INGREDIENTS_SEED, 'utf8'));
        await prisma.ingredient.createMany({ data: seed });
        console.log('Seeded', seed.length, 'ingredients to Postgres');
      }
    }
    if (fs.existsSync(STD_INV_SEED)) {
      const count = await prisma.standardInventory.count();
      if (count === 0) {
        const seed = JSON.parse(fs.readFileSync(STD_INV_SEED, 'utf8'));
        await prisma.standardInventory.createMany({ data: seed });
        console.log('Seeded', seed.length, 'standard inventory items to Postgres');
      }
    }
  } catch (e: unknown) {
    console.error('Seed failed:', errMsg(e));
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
