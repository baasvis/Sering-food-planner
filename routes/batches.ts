import crypto from 'crypto';
import express, { Request, Response } from 'express';
import { prisma, validateBatch, withWriteLock, dbAppendLog, toBatchRow } from '../lib/db';
import { errMsg } from '../lib/config';
import type { Batch } from '../shared/types';

const router = express.Router();

// GET /api/batches — list all batches
router.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.batch.findMany();
    const batches = rows.map(b => ({
      ...toBatchRow(b as unknown as Batch),
      services: Array.isArray(b.services) ? b.services : [],
    }));
    res.json(batches);
  } catch (e: unknown) { res.status(500).json({ error: errMsg(e) }); }
});

// GET /api/batches/:id — get single batch
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const b = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    res.json({
      ...toBatchRow(b as unknown as Batch),
      services: Array.isArray(b.services) ? b.services : [],
    });
  } catch (e: unknown) { res.status(500).json({ error: errMsg(e) }); }
});

// POST /api/batches — create batch
router.post('/', async (req: Request, res: Response) => {
  try {
    const b = req.body;
    if (!b.id) b.id = crypto.randomUUID();
    if (!b.createdAt) b.createdAt = new Date().toISOString();
    if (typeof b.stock === 'undefined') b.stock = 0;
    if (typeof b.serving === 'undefined') b.serving = 280;
    if (!b.storage) b.storage = 'Gastro';
    if (!b.location) b.location = 'west';
    if (!b.services) b.services = [];

    const err = validateBatch(b as Batch);
    if (err) return res.status(400).json({ error: err });

    const created = await withWriteLock(async () => {
      const existing = await prisma.batch.findUnique({ where: { id: b.id } });
      if (existing) throw new Error(`Batch "${b.id}" already exists`);
      return prisma.batch.create({ data: toBatchRow(b as Batch) });
    });

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'batch-create', `${b.name} (${b.id})`);

    res.status(201).json({
      ...toBatchRow(created as unknown as Batch),
      services: Array.isArray(created.services) ? created.services : [],
    });
  } catch (e: unknown) {
    if (errMsg(e).includes('already exists')) return res.status(409).json({ error: errMsg(e) });
    res.status(500).json({ error: errMsg(e) });
  }
});

// PATCH /api/batches/:id — partial update
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const updates = req.body;
    delete updates.id;

    const updated = await withWriteLock(async () => {
      const existing = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
      if (!existing) throw new Error('not found');

      const merged = {
        ...toBatchRow(existing as unknown as Batch),
        services: Array.isArray(existing.services) ? existing.services : [],
        ...updates,
      };
      const err = validateBatch(merged as Batch);
      if (err) throw new Error(err);

      return prisma.batch.update({
        where: { id: req.params.id as string },
        data: toBatchRow(merged as Batch),
      });
    });

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'batch-update', `${updated.name} (${req.params.id as string})`);

    res.json({
      ...toBatchRow(updated as unknown as Batch),
      services: Array.isArray(updated.services) ? updated.services : [],
    });
  } catch (e: unknown) {
    if (errMsg(e) === 'not found') return res.status(404).json({ error: 'Batch not found' });
    if (errMsg(e).startsWith('invalid') || errMsg(e).startsWith('missing')) return res.status(400).json({ error: errMsg(e) });
    res.status(500).json({ error: errMsg(e) });
  }
});

// DELETE /api/batches/:id — delete batch (only if stock === 0)
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await withWriteLock(async () => {
      const existing = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
      if (!existing) throw new Error('not found');
      if (existing.stock > 0) throw new Error('cannot delete batch with stock > 0');
      await prisma.batch.delete({ where: { id: req.params.id as string } });
    });

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'batch-delete', req.params.id as string);

    res.json({ ok: true });
  } catch (e: unknown) {
    if (errMsg(e) === 'not found') return res.status(404).json({ error: 'Batch not found' });
    if (errMsg(e).includes('stock > 0')) return res.status(400).json({ error: errMsg(e) });
    res.status(500).json({ error: errMsg(e) });
  }
});

export default router;
