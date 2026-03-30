import express, { Request, Response } from 'express';
import { dbReadAll, dbWriteAll, dbAppendLog, getDefaultGuests, validateBatches, validateGuests, withWriteLock, dbWriteBatches, dbWriteGuests, dbWriteCaterings, dbWriteTransportItems } from '../lib/db';
import { broadcast } from './events';

const router = express.Router();

router.get('/', async (_req: Request, res: Response) => {
  try { res.json(await dbReadAll()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req: Request, res: Response) => {
  try {
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

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

router.post('/patch', async (req: Request, res: Response) => {
  try {
    const { batches, deletedBatches, guests, caterings, deletedCaterings,
            transportItems, deletedTransportItems } = req.body;

    await withWriteLock(async () => {
      const current = await dbReadAll();

      // Merge batches
      if ((batches && batches.length) || (deletedBatches && deletedBatches.length)) {
        const batchMap = new Map(current.batches.map((b: any) => [b.id, b]));
        if (deletedBatches) deletedBatches.forEach((id: string) => batchMap.delete(id));
        if (batches && batches.length) {
          const batchErr = validateBatches(batches);
          if (batchErr) throw new Error(batchErr);
          batches.forEach((b: any) => batchMap.set(b.id, b));
        }
        await dbWriteBatches([...batchMap.values()]);
      }

      // Merge guests
      if (guests) {
        const guestErr = validateGuests(guests);
        if (guestErr) throw new Error(guestErr);
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

      // Merge caterings
      if ((caterings && caterings.length) || (deletedCaterings && deletedCaterings.length)) {
        const catMap = new Map(current.caterings.map((c: any) => [c.id, c]));
        if (deletedCaterings) deletedCaterings.forEach((id: string) => catMap.delete(id));
        if (caterings) caterings.forEach((c: any) => catMap.set(c.id, c));
        await dbWriteCaterings([...catMap.values()]);
      }

      // Merge transport items
      if ((transportItems && transportItems.length) || (deletedTransportItems && deletedTransportItems.length)) {
        const trMap = new Map(current.transportItems.map((t: any) => [t.id, t]));
        if (deletedTransportItems) deletedTransportItems.forEach((id: string) => trMap.delete(id));
        if (transportItems) transportItems.forEach((t: any) => trMap.set(t.id, t));
        await dbWriteTransportItems([...trMap.values()]);
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

    const result: any = { ok: true, savedAt: new Date().toISOString() };
    if (concurrent) result.concurrent = concurrent;
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
