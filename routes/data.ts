import express, { Request, Response } from 'express';
import { dbReadAll, dbWriteAll, dbAppendLog, getDefaultGuests, validateBatches, validateGuests, withWriteLock, dbWriteGuests, dbUpsertBatches, dbDeleteBatchIds, dbUpsertCaterings, dbDeleteCateringIds, dbUpsertTransportItems, dbDeleteTransportItemIds } from '../lib/db';
import { broadcast } from './events';
import { asyncHandler, AppError } from '../lib/config';
import type { Batch, Catering, TransportItem } from '../shared/types';

const router = express.Router();

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  res.json(await dbReadAll());
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const batches = req.body.batches || [];
  const guests = req.body.guests || getDefaultGuests();
  const caterings = req.body.caterings || [];
  const transportItems = req.body.transportItems || [];

  const batchErr = validateBatches(batches);
  if (batchErr) return res.status(400).json({ error: batchErr });
  const guestErr = validateGuests(guests);
  if (guestErr) return res.status(400).json({ error: guestErr });

  await dbWriteAll(batches, guests, caterings, transportItems);

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'save', `${batches.length} batches`);

  res.json({ ok: true, savedAt: new Date().toISOString() });
}));

// ── Concurrent save detection ──
const CONCURRENT_WINDOW_MS = 5 * 60 * 1000;
let _lastSave: { email: string; name: string; at: number } | null = null;

function checkConcurrent(user: { email: string; name: string }) {
  const now = Date.now();
  const prev = _lastSave;
  _lastSave = { email: user.email, name: user.name, at: now };
  if (prev && prev.email !== user.email && (now - prev.at) < CONCURRENT_WINDOW_MS) {
    const agoSec = Math.round((now - prev.at) / 1000);
    return { recentUser: prev.name, agoSeconds: agoSec };
  }
  return null;
}

// ── Patch save: item-level merge to prevent concurrent overwrites ──

router.post('/patch', asyncHandler(async (req: Request, res: Response) => {
  const { batches, deletedBatches, guests, caterings, deletedCaterings,
          transportItems, deletedTransportItems } = req.body;

  await withWriteLock(async () => {
    // Batches: targeted upsert/delete (no more delete-all/create-all)
    if ((batches && batches.length) || (deletedBatches && deletedBatches.length)) {
      if (deletedBatches && deletedBatches.length) {
        await dbDeleteBatchIds(deletedBatches);
      }
      if (batches && batches.length) {
        const batchErr = validateBatches(batches);
        if (batchErr) throw new AppError(400, batchErr);
        // Field-level merge: upsert reads existing row and merges,
        // so stale fields from one client don't overwrite fresh changes
        await dbUpsertBatches(batches);
      }
    }

    // Guests: read current, merge changed days, write back
    if (guests) {
      const guestErr = validateGuests(guests);
      if (guestErr) throw new AppError(400, guestErr);
      const current = await dbReadAll();
      const merged = current.guests;
      for (const loc of ['west', 'centraal']) {
        if (!guests[loc]) continue;
        for (const day of Object.keys(guests[loc])) {
          if (!merged[loc][day]) continue;
          merged[loc][day] = guests[loc][day];
        }
      }
      await dbWriteGuests(merged);
    }

    // Caterings: targeted upsert/delete
    if ((caterings && caterings.length) || (deletedCaterings && deletedCaterings.length)) {
      if (deletedCaterings && deletedCaterings.length) {
        await dbDeleteCateringIds(deletedCaterings);
      }
      if (caterings && caterings.length) {
        await dbUpsertCaterings(caterings);
      }
    }

    // Transport items: targeted upsert/delete
    if ((transportItems && transportItems.length) || (deletedTransportItems && deletedTransportItems.length)) {
      if (deletedTransportItems && deletedTransportItems.length) {
        await dbDeleteTransportItemIds(deletedTransportItems);
      }
      if (transportItems && transportItems.length) {
        await dbUpsertTransportItems(transportItems);
      }
    }
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const concurrent = checkConcurrent(user);
  dbAppendLog(user.email, user.name, 'patch',
    `B:${(batches||[]).length}u/${(deletedBatches||[]).length}d G:${guests?'y':'n'} C:${(caterings||[]).length}/${(deletedCaterings||[]).length}d T:${(transportItems||[]).length}/${(deletedTransportItems||[]).length}d`);

  // Broadcast the patch to all other connected clients
  broadcast(user.email, 'patch', {
    user: user.name,
    batches, deletedBatches, guests,
    caterings, deletedCaterings,
    transportItems, deletedTransportItems,
  });

  const result: { ok: true; savedAt: string; concurrent?: { recentUser: string; agoSeconds: number } } = { ok: true, savedAt: new Date().toISOString() };
  if (concurrent) result.concurrent = concurrent;
  res.json(result);
}));

export default router;
