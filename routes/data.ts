import express, { Request, Response } from 'express';
import { dbReadAll, dbAppendLog, validateBatches, validateGuests, validateCaterings, validateTransportItems, validateIdList, withWriteLock, dbWriteGuests, dbUpsertBatches, dbDeleteBatchIds, dbUpsertCaterings, dbDeleteCateringIds, dbUpsertTransportItems, dbDeleteTransportItemIds } from '../lib/db';
import { broadcast } from './events';
import { asyncHandler, AppError } from '../lib/config';

const router = express.Router();

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  res.json(await dbReadAll());
}));

// Legacy POST /api/data — full replace of batches/guests/caterings/transport.
// Superseded by POST /api/data/patch (targeted upsert/delete). Kept reachable
// only to return a clear refusal: a stale browser tab from a previous version
// could otherwise issue a destructive delete-all-then-create-all against live
// data. Frontend has used /patch since the 2026-03-23 batch model rewrite.
router.post('/', asyncHandler(async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Legacy save endpoint removed',
    message: 'POST /api/data is no longer supported. Use POST /api/data/patch.',
  });
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

  // Validate ALL inputs before acquiring the lock. The previous version only
  // validated batches and guests; deletedBatches/Caterings/TransportItems and
  // the caterings/transportItems arrays themselves were passed straight to
  // Prisma, which meant a misbehaving authenticated client could mass-delete
  // by sending a giant array of IDs. (Audit §6.1.)
  if (deletedBatches !== undefined) {
    const err = validateIdList(deletedBatches, 'deletedBatches');
    if (err) throw new AppError(400, err);
  }
  if (deletedCaterings !== undefined) {
    const err = validateIdList(deletedCaterings, 'deletedCaterings');
    if (err) throw new AppError(400, err);
  }
  if (deletedTransportItems !== undefined) {
    const err = validateIdList(deletedTransportItems, 'deletedTransportItems');
    if (err) throw new AppError(400, err);
  }
  if (batches !== undefined) {
    const err = validateBatches(batches);
    if (err) throw new AppError(400, err);
  }
  if (guests !== undefined && guests !== null) {
    const err = validateGuests(guests);
    if (err) throw new AppError(400, err);
  }
  if (caterings !== undefined) {
    const err = validateCaterings(caterings);
    if (err) throw new AppError(400, err);
  }
  if (transportItems !== undefined) {
    const err = validateTransportItems(transportItems);
    if (err) throw new AppError(400, err);
  }

  await withWriteLock(async () => {
    // Batches: targeted upsert/delete (no more delete-all/create-all)
    if ((batches && batches.length) || (deletedBatches && deletedBatches.length)) {
      if (deletedBatches && deletedBatches.length) {
        await dbDeleteBatchIds(deletedBatches);
      }
      if (batches && batches.length) {
        // Field-level merge: upsert reads existing row and merges,
        // so stale fields from one client don't overwrite fresh changes
        await dbUpsertBatches(batches);
      }
    }

    // Guests: read current, merge changed days, write back
    if (guests) {
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
