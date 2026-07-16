// ─────────────────────────────────────────────────────────────────────────────
// EVENT LOCATIONS — temporary festival/catering sites (e.g. Landjuweel 2026).
//
// A registry row turns a slug ("ev-<name>") into a first-class location: its
// own planner tab, guest counts, batch inventory/services, transport, orders
// and stocktake. Lifecycle: create → active → archived. Archive HIDES the
// location (pickers/tabs) but the slug stays a valid key forever — batch
// history, guest rows and supply stock keep validating and rendering.
//
// Director-only writes (requireDirector); every mutation refreshes the
// lib/locations.ts cache via dbLoadEventLocations() and broadcasts the full
// fresh list over SSE (the table is tiny — no delta merging).
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { prisma, dbAppendLog, dbLoadEventLocations, withWriteLock } from '../lib/db';
import { asyncHandler, AppError } from '../lib/config';
import { broadcast } from './events';
import { requireDirector } from './auth';
import { invalidateClient } from '../lib/hanos-client';
import { RESERVED_LOCATION_KEYS } from '../shared/location';
import { todayIso } from '../shared/dates';
import type { EventLocationDTO, Shipment } from '../shared/types';

const router = express.Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SLUG_LEN = 40;

/** Derive the immutable slug from the display name: "Landjuweel 2026" →
 *  "ev-landjuweel-2026". The fixed "ev-" prefix structurally guarantees no
 *  collision with 'west'/'centraal'/'testtafel'; RESERVED_LOCATION_KEYS is
 *  checked anyway (belt and braces). */
export function deriveSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN - 3);
  return `ev-${base || 'event'}`.replace(/-+$/, '');
}

interface EventLocationInput {
  name?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  hanosAccount?: unknown;
}

/** Validate the editable fields. Throws AppError(400). Returns the cleaned
 *  values. `partial` allows PATCH to send a subset. */
function cleanInput(body: EventLocationInput, partial = false): {
  name?: string; startDate?: string; endDate?: string; hanosAccount?: 'west' | 'centraal';
} {
  const out: { name?: string; startDate?: string; endDate?: string; hanosAccount?: 'west' | 'centraal' } = {};
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 60) {
      throw new AppError(400, 'invalid name (1-60 characters)');
    }
    // The name is rendered by locName()/shortLocName() into innerHTML all
    // over the frontend (planner tabs, transport rows, modals, toasts), and
    // not every legacy sink escapes. Reject markup-capable characters at the
    // source so a name can never carry stored XSS or break a double-quoted
    // attribute. Apostrophes stay allowed ("Daan's Fest") — names are never
    // interpolated into single-quoted JS contexts (only slugs are).
    if (/[<>"&]/.test(body.name)) {
      throw new AppError(400, 'invalid name — the characters < > " & are not allowed');
    }
    out.name = body.name.trim();
  }
  if (body.startDate !== undefined || !partial) {
    if (typeof body.startDate !== 'string' || !ISO_DATE.test(body.startDate)) {
      throw new AppError(400, 'invalid startDate (expected YYYY-MM-DD)');
    }
    out.startDate = body.startDate;
  }
  if (body.endDate !== undefined || !partial) {
    if (typeof body.endDate !== 'string' || !ISO_DATE.test(body.endDate)) {
      throw new AppError(400, 'invalid endDate (expected YYYY-MM-DD)');
    }
    out.endDate = body.endDate;
  }
  if (body.hanosAccount !== undefined) {
    if (body.hanosAccount !== 'west' && body.hanosAccount !== 'centraal') {
      throw new AppError(400, "invalid hanosAccount (expected 'west' or 'centraal')");
    }
    out.hanosAccount = body.hanosAccount;
  }
  return out;
}

function assertDateOrder(startDate: string, endDate: string): void {
  if (endDate < startDate) throw new AppError(400, 'endDate must be on or after startDate');
}

/** Batches with an un-arrived shipment to or from `slug` — archiving while
 *  food is in transit would strand it (the arrival UI lives on the location's
 *  own dashboard). Returns batch names for the error message. */
async function pendingShipmentBlockers(slug: string): Promise<string[]> {
  const batches = await prisma.batch.findMany({ select: { name: true, shipments: true } });
  const names: string[] = [];
  for (const b of batches) {
    const ships = (b.shipments ?? []) as unknown as Shipment[];
    if (ships.some(s => !s.arrived && (s.toLoc === slug || s.fromLoc === slug))) names.push(b.name);
  }
  return names;
}

/** Non-blocking archive warnings: settled stock still at the location and
 *  upcoming services. Legitimate states (leftovers get transferred back to
 *  West after archive), surfaced so the director archives with open eyes. */
async function archiveWarnings(slug: string): Promise<string[]> {
  const batches = await prisma.batch.findMany({ select: { name: true, inventory: true, services: true } });
  // Local date, not UTC (repo rule — see shared/dates): between 00:00 and
  // ~02:00 Amsterdam a UTC "today" would count yesterday's served services
  // as upcoming.
  const today = todayIso();
  const warnings: string[] = [];
  let stockL = 0, stockBatches = 0, upcoming = 0;
  for (const b of batches) {
    const inv = (b.inventory ?? []) as unknown as { loc: string; qty: number }[];
    const atLoc = inv.filter(e => e.loc === slug).reduce((s, e) => s + (e.qty || 0), 0);
    if (atLoc > 0) { stockL += atLoc; stockBatches++; }
    const svcs = (b.services ?? []) as unknown as { loc: string; date: string }[];
    upcoming += svcs.filter(s => s.loc === slug && s.date >= today).length;
  }
  if (stockBatches > 0) warnings.push(`${Math.round(stockL * 10) / 10} L stock in ${stockBatches} batch${stockBatches === 1 ? '' : 'es'} still at this location — transfer leftovers back to West if any food remains`);
  if (upcoming > 0) warnings.push(`${upcoming} upcoming service assignment${upcoming === 1 ? '' : 's'} at this location will be hidden`);
  return warnings;
}

// ── Routes ──

// List (any signed-in user). ?activeOnly=1 filters out archived rows.
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const rows = await dbLoadEventLocations();
  const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
  res.json(activeOnly ? rows.filter(r => !r.archived) : rows);
}));

// Create (director-only).
router.post('/', requireDirector, asyncHandler(async (req: Request, res: Response) => {
  const input = cleanInput(req.body as EventLocationInput);
  assertDateOrder(input.startDate as string, input.endDate as string);

  const created = await withWriteLock(async () => {
    const base = deriveSlug(input.name as string);
    if (RESERVED_LOCATION_KEYS.includes(base) || RESERVED_LOCATION_KEYS.includes(base.replace(/^ev-/, ''))) {
      throw new AppError(400, `"${input.name}" is a reserved location name`);
    }
    // Slugs are immutable and never reused (even archived) — auto-suffix on
    // collision so "Landjuweel" next year becomes ev-landjuweel-2.
    let slug = base;
    for (let n = 2; await prisma.eventLocation.findUnique({ where: { id: slug } }); n++) {
      slug = `${base}-${n}`;
      if (n > 50) throw new AppError(400, 'could not derive a unique slug');
    }
    return prisma.eventLocation.create({
      data: {
        id: slug,
        name: input.name as string,
        startDate: input.startDate as string,
        endDate: input.endDate as string,
        hanosAccount: input.hanosAccount ?? 'west',
        createdBy: req.user?.email || '',
      },
    });
  });

  const rows = await dbLoadEventLocations();
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'event-location-create', `${created.id} (${created.name}, ${created.startDate}..${created.endDate})`);
  broadcast(user.email, 'patch', { user: user.name, eventLocations: rows });
  res.status(201).json(rows.find(r => r.slug === created.id));
}));

// Edit name/dates/hanosAccount (director-only). The slug is immutable.
router.patch('/:slug', requireDirector, asyncHandler(async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  const input = cleanInput(req.body as EventLocationInput, true);
  if (Object.keys(input).length === 0) throw new AppError(400, 'nothing to update');

  await withWriteLock(async () => {
    const existing = await prisma.eventLocation.findUnique({ where: { id: slug } });
    if (!existing) throw new AppError(404, 'Event location not found');
    const startDate = input.startDate ?? existing.startDate;
    const endDate = input.endDate ?? existing.endDate;
    assertDateOrder(startDate, endDate);
    await prisma.eventLocation.update({ where: { id: slug }, data: input });
  });
  // A changed hanosAccount must not keep add-to-cart going to the OLD
  // account's cart for the pooled client's remaining TTL (up to 10 min).
  if (input.hanosAccount !== undefined) invalidateClient(slug);

  const rows = await dbLoadEventLocations();
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'event-location-update', `${slug}: ${Object.keys(input).join(', ')}`);
  broadcast(user.email, 'patch', { user: user.name, eventLocations: rows });
  res.json(rows.find(r => r.slug === slug));
}));

// Archive (director-only). Hard-blocks on un-arrived shipments touching the
// location; returns soft warnings for settled stock / upcoming services.
router.post('/:slug/archive', requireDirector, asyncHandler(async (req: Request, res: Response) => {
  const slug = req.params.slug as string;

  let warnings: string[] = [];
  await withWriteLock(async () => {
    const existing = await prisma.eventLocation.findUnique({ where: { id: slug } });
    if (!existing) throw new AppError(404, 'Event location not found');
    if (existing.archived) throw new AppError(400, 'Already archived');
    const blockers = await pendingShipmentBlockers(slug);
    if (blockers.length) {
      throw new AppError(400, `Cannot archive: food is still in transit to/from this location (${blockers.slice(0, 5).join(', ')}). Mark the shipments arrived (or cancel them) first.`);
    }
    warnings = await archiveWarnings(slug);
    await prisma.eventLocation.update({
      where: { id: slug },
      data: { archived: true, archivedAt: new Date() },
    });
  });

  const rows = await dbLoadEventLocations();
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'event-location-archive', slug);
  broadcast(user.email, 'patch', { user: user.name, eventLocations: rows });
  res.json({ ok: true, warnings, eventLocation: rows.find(r => r.slug === slug) });
}));

// Unarchive (director-only) — cheap undo, also "same festival, second weekend".
router.post('/:slug/unarchive', requireDirector, asyncHandler(async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  await withWriteLock(async () => {
    const existing = await prisma.eventLocation.findUnique({ where: { id: slug } });
    if (!existing) throw new AppError(404, 'Event location not found');
    if (!existing.archived) throw new AppError(400, 'Not archived');
    await prisma.eventLocation.update({
      where: { id: slug },
      data: { archived: false, archivedAt: null },
    });
  });

  const rows = await dbLoadEventLocations();
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'event-location-unarchive', slug);
  broadcast(user.email, 'patch', { user: user.name, eventLocations: rows });
  res.json({ ok: true, eventLocation: rows.find(r => r.slug === slug) });
}));

// Hard delete (director-only) — an ARCHIVED, zero-reference location only.
// Exists for e2e/staging hygiene ("E2E Fest …" rows) and genuine mistakes; a
// USED location is archived, never deleted — its slug is referenced by batch
// history. Removes the location's own per-loc side rows (guest pattern,
// standard inventory, prep checklists, ritual completions) with it.
router.delete('/:slug', requireDirector, asyncHandler(async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  await withWriteLock(async () => {
    const existing = await prisma.eventLocation.findUnique({ where: { id: slug } });
    if (!existing) throw new AppError(404, 'Event location not found');
    if (!existing.archived) throw new AppError(400, 'Archive it first — delete is only for archived locations');

    // Zero-reference scan. Deleting frees the slug for reuse, so EVERY store
    // that references it must either block the delete (meaningful data) or be
    // purged below (this location's own rows) — otherwise a recreated
    // same-name event silently inherits the dead event's data.
    const batches = await prisma.batch.findMany({ select: { name: true, inventory: true, shipments: true, services: true } });
    for (const b of batches) {
      const inv = (b.inventory ?? []) as unknown as { loc: string }[];
      const ships = (b.shipments ?? []) as unknown as Shipment[];
      const svcs = (b.services ?? []) as unknown as { loc: string }[];
      if (inv.some(e => e.loc === slug) || svcs.some(s => s.loc === slug)
          || ships.some(s => s.toLoc === slug || s.fromLoc === slug)) {
        throw new AppError(400, `Cannot delete: batch "${b.name}" still references this location. Archived is the right end state for a used location.`);
      }
    }
    // Supplies: a one-off pointing here, or any stock recorded here, blocks —
    // deleting the registry row would silently erase that stock on the next
    // normalize-and-write cycle (isKnownLocation would drop the key).
    const supplies = await prisma.supply.findMany({ select: { name: true, oneoffLocation: true, stock: true } });
    for (const s of supplies) {
      const stock = (s.stock ?? {}) as Record<string, { amount?: number } | undefined>;
      if (s.oneoffLocation === slug) {
        throw new AppError(400, `Cannot delete: supply "${s.name}" is a one-off at this location. Re-point or delete the supply first.`);
      }
      if ((stock[slug]?.amount ?? 0) > 0) {
        throw new AppError(400, `Cannot delete: supply "${s.name}" still has stock recorded at this location. Zero it first.`);
      }
    }
    // Ingredient DB: counted stock or order targets at this location block —
    // same silent-inheritance risk for a recreated slug.
    const ingredients = await prisma.ingredient.findMany({ select: { name: true, stock: true, targetStock: true } });
    for (const ing of ingredients) {
      const stock = (ing.stock ?? {}) as Record<string, { amount?: number } | undefined>;
      const target = (ing.targetStock ?? {}) as Record<string, number | undefined>;
      if ((stock[slug]?.amount ?? 0) > 0 || (target[slug] ?? 0) > 0) {
        throw new AppError(400, `Cannot delete: ingredient "${ing.name}" still has stock or an order target at this location. Zero it first (or leave the event archived).`);
      }
    }

    // Purge this location's own side rows + JSON keys so nothing is orphaned
    // and a reused slug starts clean.
    await prisma.guest.deleteMany({ where: { location: slug } });
    await prisma.guestsNextWeeks.deleteMany({ where: { location: slug } });
    await prisma.standardInventory.deleteMany({ where: { location: slug } });
    await prisma.prepChecklist.deleteMany({ where: { loc: slug } });
    await prisma.ritualCompletion.deleteMany({ where: { loc: slug } });
    const storageCfg = await prisma.storageConfig.findUnique({ where: { id: 'default' } });
    if (storageCfg && storageCfg.config && typeof storageCfg.config === 'object' && !Array.isArray(storageCfg.config)) {
      const cfg = { ...(storageCfg.config as Record<string, unknown>) };
      if (slug in cfg) {
        delete cfg[slug];
        await prisma.storageConfig.update({ where: { id: 'default' }, data: { config: cfg as object } });
      }
    }
    // Zero-amount stock keys (0 blocks nothing above) are cleaned too.
    for (const s of await prisma.supply.findMany({ select: { id: true, stock: true } })) {
      const stock = (s.stock ?? {}) as Record<string, unknown>;
      if (slug in stock) {
        const next = { ...stock };
        delete next[slug];
        await prisma.supply.update({ where: { id: s.id }, data: { stock: next as object } });
      }
    }
    for (const ing of await prisma.ingredient.findMany({ select: { id: true, stock: true, targetStock: true } })) {
      const stock = (ing.stock ?? {}) as Record<string, unknown>;
      const target = (ing.targetStock ?? {}) as Record<string, unknown>;
      if (slug in stock || slug in target) {
        const nextStock = { ...stock }; delete nextStock[slug];
        const nextTarget = { ...target }; delete nextTarget[slug];
        await prisma.ingredient.update({ where: { id: ing.id }, data: { stock: nextStock as object, targetStock: nextTarget as object } });
      }
    }
    await prisma.eventLocation.delete({ where: { id: slug } });
  });

  invalidateClient(slug); // drop any pooled Hanos client for the dead slug
  const rows = await dbLoadEventLocations();
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'event-location-delete', slug);
  broadcast(user.email, 'patch', { user: user.name, eventLocations: rows });
  res.json({ ok: true });
}));

export default router;
export type { EventLocationDTO };
