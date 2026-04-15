// ─────────────────────────────────────────────────────────────────────────────
// DE SERING FOOD PLANNER — SERVER (v5 — PostgreSQL)
// ─────────────────────────────────────────────────────────────────────────────

try { require('dotenv').config(); } catch (_e) { /* dotenv optional in production */ }

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { CONFIG, INGREDIENTS_SEED, STD_INV_SEED, errMsg } from './lib/config';
import { prisma } from './lib/db';
import app from './app';
import { startFlushTimer, stopFlushTimer } from './routes/telemetry';

// ── Nightly finance sync (Tebi POS → DailyRevenue) ──
// Root cause for the multi-week sync gap: there was no cron. The sync only
// ran when someone clicked "Sync from Tebi" in the Finance screen, which the
// telemetry shows is almost never visited. This cron runs the scraper every
// night for the last N days; upsert is idempotent so re-syncing is safe and
// new missing days get filled automatically.
function runTebiSync(startDate: string, endDate: string): void {
  if (!process.env.TEBI_EMAIL || !process.env.TEBI_PASSWORD) {
    console.log('[finance-cron] TEBI credentials not set, skipping scheduled sync');
    return;
  }
  // Scripts/ is not in the TS compile tree so it stays at project root in
  // both dev and production. Railway starts `node dist/server/server.js` from
  // the project root, so process.cwd() is reliable in both environments.
  const resolvedPath = path.join(process.cwd(), 'scripts', 'tebi-sync-worker.js');
  console.log(`[finance-cron] Running Tebi sync for ${startDate} → ${endDate}`);
  const child = spawn('node', [resolvedPath, startDate, endDate], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', d => process.stdout.write(`[finance-cron] ${d}`));
  child.stderr?.on('data', d => process.stderr.write(`[finance-cron] ${d}`));
  child.on('close', code => {
    if (code === 0) console.log('[finance-cron] Sync complete');
    else console.error(`[finance-cron] Sync failed with exit code ${code}`);
  });
  // No hard timeout — scraper can take several minutes when backfilling.
  // If it hangs, the next cron tick will start a new one (spawn doesn't wait).
}

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
  console.log('  ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'set' : 'NOT SET');
  seedIfNeeded();

  // Start telemetry buffer flushing (writes buffered events to DB every 60s)
  startFlushTimer();

  // Scheduled AI analysis + telemetry cleanup
  if (process.env.ANTHROPIC_API_KEY) {
    import('node-cron').then(cron => {
      const schedule = process.env.AI_ANALYSIS_CRON || '0 7 * * *';
      cron.schedule(schedule, async () => {
        try {
          const { generateInsights } = await import('./lib/ai-analyzer');
          const count = await generateInsights();
          console.log(`Scheduled AI analysis complete: ${count} insights`);
        } catch (e: unknown) {
          console.error('Scheduled AI analysis failed:', errMsg(e));
        }
      });
      console.log('  AI analysis scheduled:', schedule);
    }).catch(() => { console.log('  node-cron not available, skipping scheduled analysis'); });
  }

  // Telemetry cleanup: delete events older than 90 days (daily at 3am)
  import('node-cron').then(cron => {
    cron.schedule('0 3 * * *', async () => {
      try {
        const { cleanupOldTelemetry } = await import('./lib/ai-analyzer');
        const count = await cleanupOldTelemetry();
        if (count > 0) console.log(`Cleaned up ${count} telemetry events older than 90 days`);
      } catch (e: unknown) {
        console.error('Telemetry cleanup failed:', errMsg(e));
      }
    });
  }).catch(() => {});

  // Nightly Tebi finance sync at 04:30 (backfill last 14 days, upsert is idempotent)
  import('node-cron').then(cron => {
    const schedule = process.env.FINANCE_SYNC_CRON || '30 4 * * *';
    cron.schedule(schedule, () => {
      const today = new Date();
      const start = new Date(today);
      start.setDate(start.getDate() - 14);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      runTebiSync(fmt(start), fmt(today));
    });
    console.log('  Finance sync scheduled:', schedule);
  }).catch(() => { console.log('  node-cron not available, skipping finance sync'); });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  stopFlushTimer();
  await prisma.$disconnect();
  process.exit(0);
});
