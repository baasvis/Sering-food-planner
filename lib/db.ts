// ─────────────────────────────────────────────────────────────────────────────
// POSTGRESQL DATA LAYER (PRISMA)
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';
import type { Batch, GuestsData, Catering, TransportItem, DataResponse } from '../shared/types';

export const prisma = new PrismaClient();

// ── Validation ──

const VALID_TYPES = ['Soup', 'Main course', 'Dessert'];
const VALID_STORAGE = ['Gastro', 'Frozen', 'Vac-packed'];
const VALID_LOCATIONS = ['west', 'centraal'];
const VALID_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const VALID_MEALS = ['lunch', 'dinner'];

export function validateBatches(batches: any[]): string | null {
  if (!Array.isArray(batches)) return 'batches must be an array';
  if (batches.length > 500) return 'Too many batches (max 500)';
  const ids = new Set<string>();
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    if (!b.id || typeof b.id !== 'string') return `Batch ${i}: missing or invalid id`;
    if (ids.has(b.id)) return `Batch ${i}: duplicate id "${b.id}"`;
    ids.add(b.id);
    if (!b.name || typeof b.name !== 'string' || b.name.length > 200) return `Batch ${i}: invalid name`;
    if (!VALID_TYPES.includes(b.type)) return `Batch ${i}: invalid type "${b.type}"`;
    if (typeof b.stock !== 'number' || b.stock < 0 || b.stock > 99999) return `Batch ${i}: invalid stock`;
    if (typeof b.serving !== 'number' || b.serving < 1 || b.serving > 9999) return `Batch ${i}: invalid serving`;
    if (!VALID_STORAGE.includes(b.storage)) return `Batch ${i}: invalid storage`;
    if (!VALID_LOCATIONS.includes(b.location)) return `Batch ${i}: invalid location "${b.location}"`;
    if (typeof b.inTransit !== 'undefined' && typeof b.inTransit !== 'boolean') return `Batch ${i}: inTransit must be boolean`;
    if (typeof b.note !== 'undefined' && (typeof b.note !== 'string' || b.note.length > 1000)) return `Batch ${i}: invalid note`;
    if (!Array.isArray(b.services)) return `Batch ${i}: services must be an array`;
    for (const svc of b.services) {
      if (!VALID_LOCATIONS.includes(svc.loc)) return `Batch ${i}: invalid service location`;
      if (!svc.date || typeof svc.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(svc.date)) return `Batch ${i}: invalid service date (expected YYYY-MM-DD)`;
      if (!VALID_MEALS.includes(svc.meal)) return `Batch ${i}: invalid service meal`;
    }
  }
  return null;
}

export function validateBatch(b: any): string | null {
  if (!b.id || typeof b.id !== 'string') return 'missing or invalid id';
  if (!b.name || typeof b.name !== 'string' || b.name.length > 200) return 'invalid name';
  if (!VALID_TYPES.includes(b.type)) return `invalid type "${b.type}"`;
  if (typeof b.stock !== 'number' || b.stock < 0 || b.stock > 99999) return 'invalid stock';
  if (typeof b.serving !== 'number' || b.serving < 1 || b.serving > 9999) return 'invalid serving';
  if (!VALID_STORAGE.includes(b.storage)) return 'invalid storage';
  if (!VALID_LOCATIONS.includes(b.location)) return `invalid location "${b.location}"`;
  if (typeof b.inTransit !== 'undefined' && typeof b.inTransit !== 'boolean') return 'inTransit must be boolean';
  if (typeof b.note !== 'undefined' && (typeof b.note !== 'string' || b.note.length > 1000)) return 'invalid note';
  if (!Array.isArray(b.services)) return 'services must be an array';
  for (const svc of b.services) {
    if (!VALID_LOCATIONS.includes(svc.loc)) return 'invalid service location';
    if (!svc.date || typeof svc.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(svc.date)) return 'invalid service date (expected YYYY-MM-DD)';
    if (!VALID_MEALS.includes(svc.meal)) return 'invalid service meal';
  }
  return null;
}

export function validateGuests(guests: any): string | null {
  if (!guests || typeof guests !== 'object') return 'guests must be an object';
  for (const loc of VALID_LOCATIONS) {
    if (!guests[loc]) return `guests.${loc} missing`;
    for (const day of VALID_DAYS) {
      if (!guests[loc][day]) return `guests.${loc}.${day} missing`;
      const g = guests[loc][day];
      if (typeof g.lunch !== 'number' || g.lunch < 0 || g.lunch > 9999) return `Invalid guest count`;
      if (typeof g.dinner !== 'number' || g.dinner < 0 || g.dinner > 9999) return `Invalid guest count`;
    }
  }
  return null;
}

// ── Default data ──

export function getDefaultGuests(): GuestsData {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const west: Record<string, { lunch: number; dinner: number }> = {};
  const centraal: Record<string, { lunch: number; dinner: number }> = {};
  days.forEach(d => {
    west[d]     = { lunch: d === 'Sat' || d === 'Sun' ? 0 : 100, dinner: d === 'Sat' || d === 'Sun' ? 0 : 110 };
    centraal[d] = { lunch: d === 'Sat' || d === 'Sun' ? 0 : 80,  dinner: d === 'Sat' || d === 'Sun' ? 0 : 85  };
  });
  return { west, centraal };
}

// ── Row transformers (frontend shape ↔ Prisma shape) ──

export function toBatchRow(b: any) {
  return {
    id: b.id,
    name: b.name,
    type: b.type,
    stock: b.stock,
    serving: b.serving || 280,
    storage: b.storage || 'Gastro',
    location: b.location || 'west',
    inTransit: !!b.inTransit,
    allergens: b.allergens || [],
    extraAllergens: b.extraAllergens || [],
    orderFor: !!b.orderFor,
    cookDate: b.cookDate || null,
    recipeSheetId: b.recipeSheetId || null,
    recipeVolume: b.recipeVolume || null,
    recipeIngredients: b.recipeIngredients || undefined,
    parentId: b.parentId || null,
    note: b.note || '',
    services: b.services || [],
    createdAt: b.createdAt || new Date().toISOString(),
  };
}

function toGuestRows(guests: GuestsData) {
  const rows: Array<{ location: string; day: string; lunch: number; dinner: number }> = [];
  for (const [loc, days] of Object.entries(guests)) {
    for (const [day, meals] of Object.entries(days)) {
      rows.push({ location: loc, day, lunch: (meals as any).lunch || 0, dinner: (meals as any).dinner || 0 });
    }
  }
  return rows;
}

function toCateringRow(c: any) {
  return {
    id: c.id,
    name: c.name || '',
    date: c.date || null,
    guestCount: c.guestCount || 0,
    deliveryMode: c.deliveryMode || 'pickup',
    dishes: c.dishes || [],
    logisticsNotes: c.logisticsNotes || '',
    createdAt: c.createdAt || new Date().toISOString(),
  };
}

function toTransportRow(t: any) {
  return { id: t.id, text: t.text };
}

// ── Shared write logic ──

async function writeBatches(tx: any, batches: any[]) {
  await tx.batch.deleteMany();
  if (batches.length > 0) {
    await tx.batch.createMany({ data: batches.map(toBatchRow) });
  }
}

async function writeGuests(tx: any, guests: GuestsData) {
  await tx.guest.deleteMany();
  const guestData = toGuestRows(guests);
  if (guestData.length > 0) {
    await tx.guest.createMany({ data: guestData });
  }
}

async function writeCaterings(tx: any, caterings: any[]) {
  await tx.catering.deleteMany();
  if (caterings && caterings.length > 0) {
    await tx.catering.createMany({ data: caterings.map(toCateringRow) });
  }
}

async function writeTransport(tx: any, items: any[]) {
  await tx.transportItem.deleteMany();
  if (items && items.length > 0) {
    await tx.transportItem.createMany({ data: items.map(toTransportRow) });
  }
}

// ── High-level database operations ──

export async function dbReadAll(): Promise<DataResponse> {
  try {
    const [batchRows, guestRows, recipeRows, cateringRows, transportRows] = await Promise.all([
      prisma.batch.findMany(),
      prisma.guest.findMany(),
      prisma.recipeIndex.findMany(),
      prisma.catering.findMany(),
      prisma.transportItem.findMany(),
    ]);

    const batches = batchRows.map(b => ({
      ...toBatchRow(b),
      services: Array.isArray(b.services) ? b.services as any[] : [],
    }));

    const guests = getDefaultGuests();
    for (const row of guestRows) {
      if (guests[row.location] && guests[row.location][row.day]) {
        guests[row.location][row.day].lunch = row.lunch;
        guests[row.location][row.day].dinner = row.dinner;
      }
    }

    const recipeIndex = recipeRows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      recipeSheetId: r.recipeSheetId,
      allergens: r.allergens,
      costPerServing: r.costPerServing,
      structure: r.structure,
      seasonality: r.seasonality,
      servingTemp: r.servingTemp,
      servingSize: r.servingSize,
      recipeVolume: r.recipeVolume,
      recipeIngredients: r.recipeIngredients,
      createdAt: r.createdAt,
      avgSkill: r.avgSkill,
      avgSpeed: r.avgSpeed,
      avgBanger: r.avgBanger,
      timesServed: r.timesServed,
    }));

    const caterings = cateringRows.map(c => ({
      id: c.id,
      name: c.name,
      date: c.date,
      guestCount: c.guestCount,
      deliveryMode: c.deliveryMode,
      dishes: c.dishes as any[],
      logisticsNotes: c.logisticsNotes,
    }));

    const transportItems = transportRows.map(t => ({ id: t.id, text: t.text }));

    return { batches, guests, recipeIndex, caterings, transportItems };
  } catch (e: any) {
    console.error('dbReadAll error:', e.message);
    return { batches: [], guests: getDefaultGuests(), recipeIndex: [], caterings: [], transportItems: [] };
  }
}

export async function dbWriteAll(batches: any[], guests: GuestsData, caterings: any[], transportItems: any[]) {
  await prisma.$transaction(async (tx) => {
    await writeBatches(tx, batches);
    await writeGuests(tx, guests);
    await writeCaterings(tx, caterings);
    await writeTransport(tx, transportItems);
  });
}

// ── Write lock — serialise writes to prevent data corruption ──

let writeLock: Promise<void> | null = null;
export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  while (writeLock) await writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>(r => { resolve = r; });
  try { return await fn(); }
  finally { writeLock = null; resolve!(); }
}

// ── Per-entity write helpers (for patch saves) ──

export async function dbWriteBatches(batches: any[]) {
  await prisma.$transaction(async (tx) => writeBatches(tx, batches));
}

export async function dbWriteGuests(guests: GuestsData) {
  await prisma.$transaction(async (tx) => writeGuests(tx, guests));
}

export async function dbWriteCaterings(caterings: any[]) {
  await prisma.$transaction(async (tx) => writeCaterings(tx, caterings));
}

export async function dbWriteTransportItems(items: any[]) {
  await prisma.$transaction(async (tx) => writeTransport(tx, items));
}

export async function dbAppendLog(userEmail: string, userName: string, action: string, details: string) {
  try {
    await prisma.log.create({
      data: {
        timestamp: new Date().toISOString(),
        email: userEmail,
        name: userName,
        action,
        details,
      },
    });
  } catch (e: any) {
    console.error('Log append error:', e.message);
  }
}
