const crypto = require('crypto');
const router = require('express').Router();
const { prisma, validateBatch, withWriteLock, dbAppendLog, toBatchRow } = require('../lib/db');

// GET /api/batches — list all batches
router.get('/', async (req, res) => {
  try {
    const rows = await prisma.batch.findMany();
    const batches = rows.map(b => ({
      ...toBatchRow(b),
      services: Array.isArray(b.services) ? b.services : [],
    }));
    res.json(batches);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/batches/:id — get single batch
router.get('/:id', async (req, res) => {
  try {
    const b = await prisma.batch.findUnique({ where: { id: req.params.id } });
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    res.json({
      ...toBatchRow(b),
      services: Array.isArray(b.services) ? b.services : [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/batches — create batch
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    if (!b.id) b.id = crypto.randomUUID();
    if (!b.createdAt) b.createdAt = new Date().toISOString();
    if (typeof b.stock === 'undefined') b.stock = 0;
    if (typeof b.serving === 'undefined') b.serving = 280;
    if (!b.storage) b.storage = 'Gastro';
    if (!b.location) b.location = 'west';
    if (!b.services) b.services = [];

    const err = validateBatch(b);
    if (err) return res.status(400).json({ error: err });

    const created = await withWriteLock(async () => {
      const existing = await prisma.batch.findUnique({ where: { id: b.id } });
      if (existing) throw new Error(`Batch "${b.id}" already exists`);
      return prisma.batch.create({ data: toBatchRow(b) });
    });

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'batch-create', `${b.name} (${b.id})`);

    res.status(201).json({
      ...toBatchRow(created),
      services: Array.isArray(created.services) ? created.services : [],
    });
  } catch (e) {
    if (e.message.includes('already exists')) return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/batches/:id — partial update
router.patch('/:id', async (req, res) => {
  try {
    const updates = req.body;
    delete updates.id; // cannot change id

    const updated = await withWriteLock(async () => {
      const existing = await prisma.batch.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new Error('not found');

      // Merge existing with updates, then validate the result
      const merged = {
        ...toBatchRow(existing),
        services: Array.isArray(existing.services) ? existing.services : [],
        ...updates,
      };
      const err = validateBatch(merged);
      if (err) throw new Error(err);

      return prisma.batch.update({
        where: { id: req.params.id },
        data: toBatchRow(merged),
      });
    });

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'batch-update', `${updated.name} (${req.params.id})`);

    res.json({
      ...toBatchRow(updated),
      services: Array.isArray(updated.services) ? updated.services : [],
    });
  } catch (e) {
    if (e.message === 'not found') return res.status(404).json({ error: 'Batch not found' });
    if (e.message.startsWith('invalid') || e.message.startsWith('missing')) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/batches/:id — delete batch (only if stock === 0)
router.delete('/:id', async (req, res) => {
  try {
    await withWriteLock(async () => {
      const existing = await prisma.batch.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new Error('not found');
      if (existing.stock > 0) throw new Error('cannot delete batch with stock > 0');
      await prisma.batch.delete({ where: { id: req.params.id } });
    });

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'batch-delete', req.params.id);

    res.json({ ok: true });
  } catch (e) {
    if (e.message === 'not found') return res.status(404).json({ error: 'Batch not found' });
    if (e.message.includes('stock > 0')) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
