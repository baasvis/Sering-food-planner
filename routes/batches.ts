import crypto from 'crypto';
import express, { Request, Response } from 'express';
import { prisma, validateBatch, withWriteLock, dbAppendLog, toBatchRow, sanitizeParentId } from '../lib/db';
import { asyncHandler, AppError } from '../lib/config';
import { broadcast } from './events';
import type { Batch } from '../shared/types';

const router = express.Router();

// GET /api/batches — list all batches
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.batch.findMany();
  const batches = rows.map(b => ({
    ...toBatchRow(b as unknown as Batch),
    services: Array.isArray(b.services) ? b.services : [],
  }));
  res.json(batches);
}));

// GET /api/batches/:id — get single batch
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const b = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  res.json({
    ...toBatchRow(b as unknown as Batch),
    services: Array.isArray(b.services) ? b.services : [],
  });
}));

// POST /api/batches — create batch
router.post('/', asyncHandler(async (req: Request, res: Response) => {
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
    if (existing) throw new AppError(409, `Batch "${b.id}" already exists`);
    // Drop stale parentId references that point at a batch another user has
    // since deleted (fixes AI insight #20 — the bulk patch and PATCH paths
    // already did this; this closes the single-create gap for split-batch
    // workflows where the client posts a new batch referencing a now-deleted
    // parent).
    const safeParentId = await sanitizeParentId((b as Batch).parentId);
    return prisma.batch.create({ data: toBatchRow({ ...(b as Batch), parentId: safeParentId }) });
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'batch-create', `${b.name} (${b.id})`);

  res.status(201).json({
    ...toBatchRow(created as unknown as Batch),
    services: Array.isArray(created.services) ? created.services : [],
  });
}));

// PATCH /api/batches/:id — partial update
router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  const updates = req.body;
  delete updates.id;

  const updated = await withWriteLock(async () => {
    const existing = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Batch not found');

    const merged = {
      ...toBatchRow(existing as unknown as Batch),
      services: Array.isArray(existing.services) ? existing.services : [],
      ...updates,
    };
    const err = validateBatch(merged as Batch);
    if (err) throw new AppError(400, err);

    // Drop stale parentId references that point at a batch another user has
    // since deleted (fixes AI insight #20 — silent P2003 FK failures).
    const safeParentId = await sanitizeParentId((merged as Batch).parentId);

    return prisma.batch.update({
      where: { id: req.params.id as string },
      data: toBatchRow({ ...(merged as Batch), parentId: safeParentId }),
    });
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'batch-update', `${updated.name} (${req.params.id as string})`);

  const batchJson = {
    ...toBatchRow(updated as unknown as Batch),
    services: Array.isArray(updated.services) ? updated.services : [],
  };

  // Broadcast the updated batch to other clients (syncs orderFor toggles etc.)
  broadcast(user.email, 'patch', { batches: [batchJson] });

  res.json(batchJson);
}));

// DELETE /api/batches/:id — delete batch (only if stock === 0)
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await withWriteLock(async () => {
    const existing = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Batch not found');
    if (existing.stock > 0) throw new AppError(400, 'Cannot delete batch with stock > 0');
    await prisma.batch.delete({ where: { id: req.params.id as string } });
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'batch-delete', req.params.id as string);

  res.json({ ok: true });
}));

export default router;
