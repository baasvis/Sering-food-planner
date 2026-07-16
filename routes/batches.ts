import crypto from 'crypto';
import express, { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, validateBatch, withWriteLock, dbAppendLog, toBatchRow, mapBatchRow } from '../lib/db';
import { isActiveLocation, isKnownLocation } from '../lib/locations';
import { asyncHandler, AppError } from '../lib/config';
import { broadcast } from './events';
import { addBackendEvent } from './telemetry';
import type { Batch, InventoryEntry, Shipment, Location, StorageType } from '../shared/types';

const router = express.Router();

// Location validity: ship/transfer DESTINATIONS must be ACTIVE (permanent ∪
// non-archived event locations); a transfer SOURCE only needs to be KNOWN so
// leftover stock can still be evacuated from a just-archived event location.
const VALID_STORAGE: StorageType[] = ['Gastro', 'Frozen', 'Vac-packed'];

// ── Inventory / shipment helpers (private to this router) ──

function parseInventory(j: unknown): InventoryEntry[] {
  return Array.isArray(j) ? (j as InventoryEntry[]) : [];
}

function parseShipments(j: unknown): Shipment[] {
  return Array.isArray(j) ? (j as Shipment[]) : [];
}

// Merge a qty into inventory by (loc, storage, cookDate). If a matching entry
// exists, add to its qty; otherwise append. Mirrors the arrival-merge rule
// (locked decision §38) so ship/arrive/cancel/transfer all use one invariant.
function mergeIntoInventory(inv: InventoryEntry[], entry: InventoryEntry): InventoryEntry[] {
  const idx = inv.findIndex(e =>
    e.loc === entry.loc && e.storage === entry.storage && e.cookDate === entry.cookDate,
  );
  if (idx >= 0) {
    inv[idx] = { ...inv[idx], qty: inv[idx].qty + entry.qty };
    return inv;
  }
  inv.push(entry);
  return inv;
}

// Today as DD/MM/YYYY — matches the format used elsewhere for Batch.cookDate
// and InventoryEntry.cookDate.
function todayDdMmYyyy(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// ── CRUD ──

// GET /api/batches — list all batches
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.batch.findMany();
  res.json(rows.map(b => mapBatchRow(b)));
}));

// GET /api/batches/:id — get single batch
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const b = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  res.json(mapBatchRow(b));
}));

// POST /api/batches — create batch
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const b = req.body;
  if (!b.id) b.id = crypto.randomUUID();
  if (!b.createdAt) b.createdAt = new Date().toISOString();
  if (typeof b.serving === 'undefined') b.serving = 280;
  if (!b.services) b.services = [];
  if (!b.inventory) b.inventory = [];
  if (!b.shipments) b.shipments = [];

  const err = validateBatch(b as Batch);
  if (err) return res.status(400).json({ error: err });

  const created = await withWriteLock(async () => {
    const existing = await prisma.batch.findUnique({ where: { id: b.id } });
    if (existing) throw new AppError(409, `Batch "${b.id}" already exists`);
    return prisma.batch.create({ data: toBatchRow(b as Batch) });
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'batch-create', `${b.name} (${b.id})`);

  res.status(201).json(mapBatchRow(created));
}));

// PATCH /api/batches/:id — partial update
router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  const updates = req.body;
  delete updates.id;

  const updated = await withWriteLock(async () => {
    const existing = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Batch not found');

    const merged: Batch = { ...mapBatchRow(existing), ...updates };
    const err = validateBatch(merged);
    if (err) throw new AppError(400, err);

    return prisma.batch.update({
      where: { id: req.params.id as string },
      data: toBatchRow(merged),
    });
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'batch-update', `${updated.name} (${req.params.id as string})`);

  const batchJson = mapBatchRow(updated);

  // Broadcast the updated batch to other clients (syncs orderFor toggles etc.)
  broadcast(user.email, 'patch', { batches: [batchJson] });

  res.json(batchJson);
}));

// DELETE /api/batches/:id — delete batch (only if total inventory qty === 0
// AND no pending shipments). Pack-accumulate can leave a source entry at 0
// while the food sits on a truck heading to Centraal — the batch row is not
// safe to delete until the in-flight shipment lands.
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await withWriteLock(async () => {
    const existing = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Batch not found');
    const inv = parseInventory(existing.inventory);
    const totalQty = inv.reduce((s, e) => s + (typeof e.qty === 'number' ? e.qty : 0), 0);
    const pendingShipmentQty = parseShipments(existing.shipments)
      .filter(s => !s.arrived)
      .reduce((sum, sh) => sum + (typeof sh.qty === 'number' ? sh.qty : 0), 0);
    if (totalQty > 0 || pendingShipmentQty > 0) {
      throw new AppError(400, 'Cannot delete batch with stock or pending shipments > 0');
    }
    await prisma.batch.delete({ where: { id: req.params.id as string } });
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'batch-delete', req.params.id as string);

  res.json({ ok: true });
}));

// ── Unified-batch model: ship / arrived / transfer / cancel ──

interface ShipBody {
  toLoc?: unknown;
  qty?: unknown;
  storage?: unknown;
  fromInventoryIdx?: unknown;
}

// POST /api/batches/:id/ship — create or accumulate a pending shipment
//
// Body: { toLoc, qty, storage?, fromInventoryIdx? }
//
// Auto-caps to the source entry's available qty (locked decision §27) and
// pack-accumulates into a non-arrived shipment with the same
// (toLoc, storage, cookDate) (locked decision §29 + audit alignment with
// arrival merge). Returns top-level `warning` when capped.
router.post('/:id/ship', asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as ShipBody;
  const toLoc = body.toLoc;
  const qty = body.qty;
  const storage = body.storage;
  const fromInventoryIdx = body.fromInventoryIdx;

  if (typeof toLoc !== 'string' || !isActiveLocation(toLoc)) {
    throw new AppError(400, 'invalid toLoc');
  }
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || qty > 99999) {
    throw new AppError(400, 'invalid qty');
  }
  if (storage !== undefined && (typeof storage !== 'string' || !VALID_STORAGE.includes(storage as StorageType))) {
    throw new AppError(400, 'invalid storage');
  }
  if (fromInventoryIdx !== undefined && (typeof fromInventoryIdx !== 'number' || !Number.isInteger(fromInventoryIdx) || fromInventoryIdx < 0)) {
    throw new AppError(400, 'invalid fromInventoryIdx');
  }

  const result = await withWriteLock(async () => {
    const existing = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Batch not found');

    const inv = parseInventory(existing.inventory);
    const ship = parseShipments(existing.shipments);

    // Re-validate the destination INSIDE the write lock: a ship queued behind
    // a concurrent archive must not create a pending shipment to a location
    // that just became archived (the exact stranded-in-transit state the
    // archive guard exists to prevent).
    if (!isActiveLocation(toLoc)) throw new AppError(400, 'invalid toLoc');

    let srcIdx = -1;
    if (typeof fromInventoryIdx === 'number') {
      const candidate = inv[fromInventoryIdx];
      if (candidate && candidate.loc !== toLoc && candidate.qty > 0
          && (storage === undefined || candidate.storage === storage)) {
        srcIdx = fromInventoryIdx;
      } else {
        // An explicit source that no longer matches is a STALE reference
        // (concurrent edit / double-send). With 3+ locations, silently
        // auto-picking "any entry whose loc differs" could drain a DIFFERENT
        // site's stock and mint a phantom cross-site shipment — fail instead
        // so the client refreshes and retries.
        throw new AppError(400, 'stale inventory reference — refresh and retry');
      }
    }
    if (srcIdx < 0) {
      srcIdx = inv.findIndex(e =>
        e.loc !== toLoc && e.qty > 0
        && (storage === undefined || e.storage === storage),
      );
    }
    if (srcIdx < 0) throw new AppError(400, 'no source inventory available to ship from');

    const source = inv[srcIdx];
    const sendQty = Math.min(qty, source.qty);
    const warning = sendQty < qty
      ? `Capped to ${sendQty} L (only ${source.qty} L available)`
      : undefined;

    const destStorage = (storage as StorageType | undefined) ?? source.storage;
    const nowIso = new Date().toISOString();

    // Pack-accumulate: same destination + storage + cookDate AND not yet
    // arrived → add to existing shipment instead of creating a new row.
    const accIdx = ship.findIndex(s =>
      !s.arrived
      && s.toLoc === toLoc
      && s.storage === destStorage
      && s.cookDate === source.cookDate,
    );
    if (accIdx >= 0) {
      ship[accIdx] = { ...ship[accIdx], qty: ship[accIdx].qty + sendQty, sentAt: nowIso };
    } else {
      ship.push({
        id: crypto.randomUUID(),
        fromLoc: source.loc,
        toLoc: toLoc as Location,
        storage: destStorage,
        qty: sendQty,
        sentAt: nowIso,
        arrived: false,
        cookDate: source.cookDate,
      });
    }

    inv[srcIdx] = { ...source, qty: source.qty - sendQty };

    const updated = await prisma.batch.update({
      where: { id: req.params.id as string },
      data: {
        inventory: inv as unknown as Prisma.InputJsonValue,
        shipments: ship as unknown as Prisma.InputJsonValue,
      },
    });
    return { updated, sendQty, warning };
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(
    user.email, user.name,
    'batch-ship',
    `${result.updated.name}: ${result.sendQty}L → ${toLoc as string}`,
  );
  addBackendEvent('feature_use', 'batch_ship', {
    batchId: req.params.id, toLoc, qty: result.sendQty, capped: !!result.warning,
  });

  const batchJson = mapBatchRow(result.updated);
  broadcast(user.email, 'patch', { batches: [batchJson] });

  const response: { ok: true; batch: Batch; warning?: string } = { ok: true, batch: batchJson };
  if (result.warning) response.warning = result.warning;
  res.json(response);
}));

// POST /api/batches/:id/shipments/:shipmentId/arrived — flip to arrived,
// merge qty into destination inventory.
router.post('/:id/shipments/:shipmentId/arrived', asyncHandler(async (req: Request, res: Response) => {
  const result = await withWriteLock(async () => {
    const existing = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Batch not found');

    const inv = parseInventory(existing.inventory);
    const ship = parseShipments(existing.shipments);

    const sIdx = ship.findIndex(s => s.id === req.params.shipmentId && !s.arrived);
    if (sIdx < 0) throw new AppError(404, 'Pending shipment not found');

    const s = ship[sIdx];
    const nowIso = new Date().toISOString();
    ship[sIdx] = { ...s, arrived: true, arrivedAt: nowIso };

    // No qty adjustment on arrival per locked decision §28: cook fixes any
    // discrepancy via the Edit modal.
    mergeIntoInventory(inv, {
      loc: s.toLoc, storage: s.storage, qty: s.qty, cookDate: s.cookDate,
    });

    const updated = await prisma.batch.update({
      where: { id: req.params.id as string },
      data: {
        inventory: inv as unknown as Prisma.InputJsonValue,
        shipments: ship as unknown as Prisma.InputJsonValue,
      },
    });
    return { updated, shipment: s };
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(
    user.email, user.name,
    'shipment-arrived',
    `${result.updated.name}: ${result.shipment.qty}L arrived at ${result.shipment.toLoc}`,
  );
  addBackendEvent('feature_use', 'shipment_mark_arrived', {
    batchId: req.params.id, shipmentId: req.params.shipmentId,
    toLoc: result.shipment.toLoc, qty: result.shipment.qty,
  });

  const batchJson = mapBatchRow(result.updated);
  broadcast(user.email, 'patch', { batches: [batchJson] });

  res.json({ ok: true, batch: batchJson });
}));

interface TransferBody {
  fromLoc?: unknown;
  fromStorage?: unknown;
  toLoc?: unknown;
  toStorage?: unknown;
  qty?: unknown;
  fromInventoryIdx?: unknown;
}

// POST /api/batches/:id/transfer — move stock between inventory entries
// within the same batch (freeze, thaw, redistribute).
router.post('/:id/transfer', asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as TransferBody;
  const { fromLoc, fromStorage, toLoc, toStorage, qty, fromInventoryIdx } = body;

  if (typeof fromLoc !== 'string' || !isKnownLocation(fromLoc)) {
    throw new AppError(400, 'invalid fromLoc');
  }
  if (typeof fromStorage !== 'string' || !VALID_STORAGE.includes(fromStorage as StorageType)) {
    throw new AppError(400, 'invalid fromStorage');
  }
  if (typeof toLoc !== 'string' || !isActiveLocation(toLoc)) {
    throw new AppError(400, 'invalid toLoc');
  }
  if (typeof toStorage !== 'string' || !VALID_STORAGE.includes(toStorage as StorageType)) {
    throw new AppError(400, 'invalid toStorage');
  }
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || qty > 99999) {
    throw new AppError(400, 'invalid qty');
  }
  if (fromInventoryIdx !== undefined && (typeof fromInventoryIdx !== 'number' || !Number.isInteger(fromInventoryIdx) || fromInventoryIdx < 0)) {
    throw new AppError(400, 'invalid fromInventoryIdx');
  }
  if (fromLoc === toLoc && fromStorage === toStorage) {
    throw new AppError(400, 'Nothing to transfer (source and destination are identical)');
  }

  const result = await withWriteLock(async () => {
    const existing = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Batch not found');

    // Same in-lock destination re-check as /ship (concurrent archive race).
    if (!isActiveLocation(toLoc)) throw new AppError(400, 'invalid toLoc');

    const inv = parseInventory(existing.inventory);
    // Source selection mirrors /ship: explicit fromInventoryIdx wins (lets a
    // cook pick which cookDate of West Gastro to freeze when there are
    // multiple); else first entry where (loc, storage, qty>0) matches.
    let srcIdx = -1;
    if (typeof fromInventoryIdx === 'number') {
      const candidate = inv[fromInventoryIdx];
      if (candidate && candidate.loc === fromLoc && candidate.storage === fromStorage && candidate.qty > 0) {
        srcIdx = fromInventoryIdx;
      }
    }
    if (srcIdx < 0) {
      srcIdx = inv.findIndex(e => e.loc === fromLoc && e.storage === fromStorage && e.qty > 0);
    }
    if (srcIdx < 0) throw new AppError(400, 'no source inventory available to transfer from');

    const source = inv[srcIdx];
    const moveQty = Math.min(qty, source.qty);
    const warning = moveQty < qty ? `Capped to ${moveQty} L` : undefined;

    // cookDate rules:
    //   Gastro → Frozen   : reset to today (freezing resets freshness, locked §22).
    //   Frozen → Gastro   : reset to today (thawed shelf-life starts today, default §1).
    //   everything else   : carry source.cookDate.
    let newCookDate = source.cookDate;
    if (
      (fromStorage === 'Gastro' && toStorage === 'Frozen')
      || (fromStorage === 'Frozen' && toStorage === 'Gastro')
    ) {
      newCookDate = todayDdMmYyyy();
    }

    inv[srcIdx] = { ...source, qty: source.qty - moveQty };
    mergeIntoInventory(inv, {
      loc: toLoc as Location,
      storage: toStorage as StorageType,
      qty: moveQty,
      cookDate: newCookDate,
    });

    const updated = await prisma.batch.update({
      where: { id: req.params.id as string },
      data: { inventory: inv as unknown as Prisma.InputJsonValue },
    });
    return { updated, moveQty, warning };
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(
    user.email, user.name,
    'batch-transfer',
    `${result.updated.name}: ${result.moveQty}L ${fromLoc as string}/${fromStorage as string} → ${toLoc as string}/${toStorage as string}`,
  );
  addBackendEvent('feature_use', 'batch_transfer', {
    batchId: req.params.id, fromLoc, fromStorage, toLoc, toStorage,
    qty: result.moveQty, capped: !!result.warning,
  });

  const batchJson = mapBatchRow(result.updated);
  broadcast(user.email, 'patch', { batches: [batchJson] });

  const response: { ok: true; batch: Batch; warning?: string } = { ok: true, batch: batchJson };
  if (result.warning) response.warning = result.warning;
  res.json(response);
}));

// POST /api/batches/:id/shipments/:shipmentId/cancel — return a pending
// shipment's qty to the source inventory entry; remove the shipment.
router.post('/:id/shipments/:shipmentId/cancel', asyncHandler(async (req: Request, res: Response) => {
  const result = await withWriteLock(async () => {
    const existing = await prisma.batch.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Batch not found');

    const inv = parseInventory(existing.inventory);
    const ship = parseShipments(existing.shipments);

    const sIdx = ship.findIndex(s => s.id === req.params.shipmentId && !s.arrived);
    if (sIdx < 0) throw new AppError(404, 'Pending shipment not found');
    const s = ship[sIdx];

    // Symmetric with /ship: undo the source decrement by merging back at
    // (fromLoc, storage, cookDate). If the entry still exists (likely, since
    // we don't auto-prune zero-qty entries) it gets topped up; otherwise a
    // new entry appears.
    mergeIntoInventory(inv, {
      loc: s.fromLoc, storage: s.storage, qty: s.qty, cookDate: s.cookDate,
    });
    ship.splice(sIdx, 1);

    const updated = await prisma.batch.update({
      where: { id: req.params.id as string },
      data: {
        inventory: inv as unknown as Prisma.InputJsonValue,
        shipments: ship as unknown as Prisma.InputJsonValue,
      },
    });
    return { updated, shipment: s };
  });

  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(
    user.email, user.name,
    'shipment-cancelled',
    `${result.updated.name}: cancelled ${result.shipment.qty}L → ${result.shipment.toLoc}`,
  );
  addBackendEvent('feature_use', 'shipment_cancel', {
    batchId: req.params.id, shipmentId: req.params.shipmentId,
    fromLoc: result.shipment.fromLoc, toLoc: result.shipment.toLoc, qty: result.shipment.qty,
  });

  const batchJson = mapBatchRow(result.updated);
  broadcast(user.email, 'patch', { batches: [batchJson] });

  res.json({ ok: true, batch: batchJson });
}));

export default router;
