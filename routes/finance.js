// ─────────────────────────────────────────────────────────────────────────────
// FINANCE — Revenue data from Tebi POS
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
const { spawn } = require('child_process');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// In-memory sync state
let syncProcess = null;
let lastSyncAt = null;
let lastSyncError = null;

// ── GET /api/finance/revenue ────────────────────────────────────────────────
// Returns DailyRevenue rows for a date range
router.get('/revenue', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required (YYYY-MM-DD)' });
  }

  const rows = await prisma.dailyRevenue.findMany({
    where: {
      date: { gte: start, lte: end },
    },
    orderBy: [{ date: 'asc' }, { location: 'asc' }],
  });

  res.json(rows);
});

// ── GET /api/finance/products ────────────────────────────────────────────────
// Returns product-level revenue, optionally filtered by location and meal
router.get('/products', async (req, res) => {
  const { start, end, location, meal, groupBy } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required (YYYY-MM-DD)' });
  }

  const where = {
    date: { gte: start, lte: end },
  };
  if (location) where.location = location;
  if (meal) where.meal = meal;

  const rows = await prisma.productRevenue.findMany({
    where,
    orderBy: [{ grossRevenue: 'desc' }],
  });

  // If groupBy=category, aggregate rows by productCategory
  if (groupBy === 'category') {
    const categories = {};
    for (const row of rows) {
      const cat = row.productCategory || 'Other';
      if (!categories[cat]) {
        categories[cat] = { productCategory: cat, quantity: 0, grossRevenue: 0, netRevenue: 0, products: 0 };
      }
      categories[cat].quantity += row.quantity;
      categories[cat].grossRevenue += row.grossRevenue;
      categories[cat].netRevenue += row.netRevenue;
      categories[cat].products += 1;
    }
    // Round and sort
    const result = Object.values(categories)
      .map(c => ({
        ...c,
        grossRevenue: Math.round(c.grossRevenue * 100) / 100,
        netRevenue: Math.round(c.netRevenue * 100) / 100,
      }))
      .sort((a, b) => b.grossRevenue - a.grossRevenue);
    return res.json(result);
  }

  res.json(rows);
});

// ── POST /api/finance/sync ──────────────────────────────────────────────────
// Triggers the Tebi sync worker as a child process
router.post('/sync', (req, res) => {
  if (syncProcess) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }

  // Check if Tebi credentials are configured
  if (!process.env.TEBI_EMAIL || !process.env.TEBI_PASSWORD) {
    return res.status(500).json({ error: 'TEBI_EMAIL and TEBI_PASSWORD not configured' });
  }

  const { startDate, endDate } = req.body;

  // Default: yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const defaultDate = yesterday.toISOString().slice(0, 10);

  const start = startDate || defaultDate;
  const end = endDate || start;

  const workerPath = path.join(__dirname, '..', 'scripts', 'tebi-sync-worker.js');
  const args = [workerPath, start, end];

  console.log(`[finance] Starting sync: ${start} → ${end}`);
  lastSyncError = null;

  syncProcess = spawn('node', args, {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  syncProcess.stdout.on('data', (data) => {
    output += data.toString();
    // Log each line
    data.toString().trim().split('\n').forEach(line => {
      if (line) console.log(`[finance] ${line}`);
    });
  });

  syncProcess.stderr.on('data', (data) => {
    output += data.toString();
    console.error(`[finance] ${data.toString().trim()}`);
  });

  syncProcess.on('close', (code) => {
    console.log(`[finance] Sync finished with code ${code}`);
    clearTimeout(syncTimeout);
    if (code === 0) {
      lastSyncAt = new Date().toISOString();
      lastSyncError = null;
    } else {
      lastSyncError = `Sync failed (exit code ${code}). ${output.slice(-500)}`;
    }
    syncProcess = null;
  });

  syncProcess.on('error', (err) => {
    console.error(`[finance] Sync process error: ${err.message}`);
    clearTimeout(syncTimeout);
    lastSyncError = `Sync process error: ${err.message}`;
    syncProcess = null;
  });

  // Kill sync after 5 minutes to prevent it from hanging forever
  const syncTimeout = setTimeout(() => {
    if (syncProcess) {
      console.error('[finance] Sync timed out after 5 minutes, killing process');
      lastSyncError = 'Sync timed out after 5 minutes';
      syncProcess.kill();
      syncProcess = null;
    }
  }, 5 * 60 * 1000);

  res.json({ status: 'syncing', startDate: start, endDate: end });
});

// ── GET /api/finance/sync-status ────────────────────────────────────────────
router.get('/sync-status', (req, res) => {
  res.json({
    syncing: !!syncProcess,
    lastSyncAt,
    lastSyncError,
    tebiConfigured: !!(process.env.TEBI_EMAIL && process.env.TEBI_PASSWORD),
  });
});

module.exports = router;
