const router = require('express').Router();
const { prisma } = require('../lib/db');

// ── Standard Inventory ──

router.get('/standard-inventory', async (req, res) => {
  try {
    const items = await prisma.standardInventory.findMany();
    res.json(items);
  } catch (e) {
    res.json([]);
  }
});

router.post('/standard-inventory', async (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected array' });
  try {
    await prisma.$transaction([
      prisma.standardInventory.deleteMany(),
      prisma.standardInventory.createMany({
        data: items.map(i => ({ id: i.id, name: i.name, amount: i.amount, unit: i.unit })),
      }),
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Prep Checklist ──

router.get('/prep-checklist', async (req, res) => {
  const { loc, date } = req.query;
  if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
  try {
    const entry = await prisma.prepChecklist.findUnique({
      where: { loc_date: { loc, date } },
    });
    res.json(entry ? entry.checked : []);
  } catch (e) {
    res.json([]);
  }
});

router.post('/prep-checklist', async (req, res) => {
  const { loc, date, checked } = req.body;
  if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
  try {
    await prisma.prepChecklist.upsert({
      where: { loc_date: { loc, date } },
      create: { loc, date, checked: Array.isArray(checked) ? checked : [] },
      update: { checked: Array.isArray(checked) ? checked : [], updatedAt: new Date() },
    });
    // Auto-expire entries older than 3 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3);
    await prisma.prepChecklist.deleteMany({
      where: { updatedAt: { lt: cutoff } },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Activity Log ──

router.get('/log', async (req, res) => {
  try {
    const rows = await prisma.log.findMany({
      orderBy: { id: 'desc' },
      take: 50,
    });
    // Return in same format as before: array of objects with timestamp, email, name, action, details
    res.json(rows.map(r => ({
      timestamp: r.timestamp,
      email: r.email,
      name: r.name,
      action: r.action,
      details: r.details,
    })));
  } catch (e) { res.json([]); }
});

module.exports = router;
