// ─────────────────────────────────────────────────────────────────────────────
// DE SERING FOOD PLANNER — SERVER (v5 — PostgreSQL)
// ─────────────────────────────────────────────────────────────────────────────

try { require('dotenv').config(); } catch (_e) { /* dotenv optional in production */ }

import fs from 'fs';
import { CONFIG, INGREDIENTS_SEED, STD_INV_SEED, errMsg } from './lib/config';
import { prisma } from './lib/db';
import app from './app';
import { startFlushTimer, stopFlushTimer, flushBuffer } from './routes/telemetry';
import { runTebiSync } from './lib/tebi-sync';

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

// ── Production-config guard (audit S3, S4) ──
//
// Refuse to boot if AUTH_MODE=production is set but the auth gate is missing.
// Without this, the dev-mode bypass at routes/auth.ts:127 makes the entire
// API public when GOOGLE_CLIENT_ID is empty (so a Railway env rotation slip
// would silently hand prod to the internet), and the email allowlist at
// routes/auth.ts:95 fails open when ALLOWED_EMAILS is empty (so any Google
// account holder gets in). Both are intentional in dev/staging; in production
// they're exit-1 configuration errors. AUTH_MODE is decoupled from NODE_ENV
// so the preview workflow (NODE_ENV=production for serving dist/client +
// dev-login for auth) keeps working.
if (CONFIG.AUTH_MODE === 'production') {
  if (!CONFIG.GOOGLE_CLIENT_ID) {
    console.error('FATAL: AUTH_MODE=production but GOOGLE_CLIENT_ID is empty.');
    console.error('Refusing to start: the dev-mode auth bypass would expose the entire API publicly.');
    console.error('Set GOOGLE_CLIENT_ID in the Railway env, or unset AUTH_MODE to opt into dev mode.');
    process.exit(1);
  }
  if (CONFIG.ALLOWED_EMAILS.length === 0) {
    console.error('FATAL: AUTH_MODE=production but ALLOWED_EMAILS is empty.');
    console.error('Refusing to start: any Google account would be allowed in.');
    console.error('Set ALLOWED_EMAILS to the comma-separated list of staff emails.');
    process.exit(1);
  }
} else if (process.env.NODE_ENV === 'production') {
  // The boot guard above is opt-in. Until AUTH_MODE=production is set on
  // Railway, the dev-mode auth bypass remains active in production. Print a
  // loud warning so the omission shows up in Railway deploy logs and Daan
  // can flip the env var when ready.
  console.warn('WARNING: NODE_ENV=production but AUTH_MODE is not set to "production".');
  console.warn('The dev-mode auth bypass is still active. Set AUTH_MODE=production in the Railway env to enable the boot guard (audit S3/S4).');
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

    // Session cleanup: delete expired auth sessions (daily at 3:15am, just
    // after telemetry to spread DB load across the maintenance window).
    cron.schedule('15 3 * * *', async () => {
      try {
        const { cleanupExpiredSessions } = await import('./routes/auth');
        const count = await cleanupExpiredSessions();
        if (count > 0) console.log(`Cleaned up ${count} expired sessions`);
      } catch (e: unknown) {
        console.error('Session cleanup failed:', errMsg(e));
      }
    });
  }).catch(() => {});

  // Nightly Tebi finance sync at 04:30 (backfill last 14 days, upsert is idempotent).
  // The shared runTebiSync() helper (lib/tebi-sync.ts) emits telemetry events
  // on completion or failure so silent breakage shows up in AI insights.
  import('node-cron').then(cron => {
    const schedule = process.env.FINANCE_SYNC_CRON || '30 4 * * *';
    cron.schedule(schedule, () => {
      const today = new Date();
      const start = new Date(today);
      start.setDate(start.getDate() - 14);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const result = runTebiSync({ start: fmt(start), end: fmt(today), source: 'cron' });
      if (!result.ok) {
        console.log(`[finance-cron] Skipped: ${result.error}`);
      }
    });
    console.log('  Finance sync scheduled:', schedule);
  }).catch(() => { console.log('  node-cron not available, skipping finance sync'); });

  // Daily Notion competency-chunk sync — Notion is the source of truth for the
  // chunk library; pull the latest in (upsert is idempotent).
  if (CONFIG.NOTION_TOKEN && CONFIG.NOTION_CHUNKS_DATA_SOURCE_ID) {
    import('node-cron').then(cron => {
      const schedule = process.env.COMPETENCY_SYNC_CRON || '0 5 * * *';
      cron.schedule(schedule, async () => {
        try {
          const { syncChunksFromNotion } = await import('./lib/notion-sync');
          const r = await syncChunksFromNotion();
          console.log(`Notion chunk sync: ${r.synced.length} synced, ${r.flagged.length} flagged`);
        } catch (e: unknown) {
          console.error('Notion chunk sync failed:', errMsg(e));
        }
      });
      console.log('  Notion chunk sync scheduled:', schedule);
    }).catch(() => {});
  }
});

// Graceful shutdown — flush the telemetry buffer before disconnecting so
// up-to-60s of buffered events (including any final error events from the
// shutdown itself) are not dropped on every deploy.
process.on('SIGTERM', async () => {
  stopFlushTimer();
  try { await flushBuffer(); } catch { /* best-effort */ }
  await prisma.$disconnect();
  process.exit(0);
});
