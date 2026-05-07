/**
 * snapshot.ts — Build 10 benchmark fixtures from a live staging snapshot.
 *
 * Connects to the database at $DATABASE_URL (staging — guard checked).
 * Reads the current state once, then generates 10 fixture JSONs:
 *   01-05: sliding "today" anchors across the next 2 weeks
 *   06:    empty-week (clear future cooking, plenty of unconfirmed)
 *   07:    surplus-stuck (one batch over-cooked by 30L)
 *   08:    stockout-pressure (high guests, modest stock)
 *   09:    frozen-rescue (mark some batches frozen, others depleted)
 *   10:    catering-heavy (3 caterings in window with high counts)
 *
 * Usage:
 *   set -a && source ../../../.env && set +a
 *   DATABASE_URL="$DATABASE_URL_TEST" npx tsx bench/menu-fixer/snapshot.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import type { Batch, Catering, GuestsData, KitchenEquipment, StorageConfig, Service } from '../../shared/types';
import type { Fixture, GuestsByWeek, GuestsLookup } from './types';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Refuse to run against the production host as a safety check.
const PROD_HOST_FRAGMENTS = ['centerbeam.proxy.rlwy.net'];

function assertNotProd(url: string): void {
  for (const frag of PROD_HOST_FRAGMENTS) {
    if (url.includes(frag)) {
      throw new Error(`DATABASE_URL points at production (${frag}); aborting. Set DATABASE_URL=$DATABASE_URL_TEST.`);
    }
  }
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateToDayName(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}

function isoToDate(iso: string): Date {
  return new Date(iso + 'T12:00:00');
}

function weekMondayIso(iso: string): string {
  const d = isoToDate(iso);
  const dow = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return dateToIso(mon);
}

// ── Load raw state ─────────────────────────────────────────────────────────

interface RawState {
  batches: Batch[];
  caterings: Catering[];
  guestsBase: GuestsData;
  guestsNextWeeks: GuestsByWeek;
  storageConfig: StorageConfig;
  kitchenEquipment: KitchenEquipment;
}

async function loadState(prisma: PrismaClient): Promise<RawState> {
  const rawBatches = await prisma.batch.findMany();
  const batches: Batch[] = rawBatches.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type as Batch['type'],
    stock: r.stock,
    serving: r.serving,
    storage: r.storage as Batch['storage'],
    location: r.location as Batch['location'],
    inTransit: r.inTransit,
    allergens: r.allergens,
    extraAllergens: r.extraAllergens,
    orderFor: r.orderFor,
    cookDate: r.cookDate,
    recipeSheetId: r.recipeSheetId,
    recipeVolume: r.recipeVolume,
    recipeIngredients: r.recipeIngredients as unknown as Batch['recipeIngredients'],
    parentId: r.parentId,
    note: r.note,
    services: r.services as unknown as Service[],
    createdAt: r.createdAt,
    recipeId: r.recipeId,
    actualIngredients: r.actualIngredients as unknown as Batch['actualIngredients'],
    cookNotes: r.cookNotes,
    stockDeducted: r.stockDeducted,
    generated: r.generated,
  }));

  const rawCaterings = await prisma.catering.findMany();
  const caterings: Catering[] = rawCaterings.map(r => ({
    id: r.id,
    name: r.name,
    date: r.date,
    guestCount: r.guestCount,
    deliveryMode: r.deliveryMode,
    dishes: r.dishes as unknown as Catering['dishes'],
    logisticsNotes: r.logisticsNotes,
    createdAt: r.createdAt,
  }));

  const rawGuests = await prisma.guest.findMany();
  const guestsBase: GuestsData = { west: {}, centraal: {} };
  for (const g of rawGuests) {
    guestsBase[g.location] ||= {};
    guestsBase[g.location][g.day] = { lunch: g.lunch, dinner: g.dinner };
  }

  const rawNextWeeks = await prisma.guestsNextWeeks.findMany();
  const guestsNextWeeks: GuestsByWeek = {};
  for (const r of rawNextWeeks) {
    guestsNextWeeks[r.mondayKey] ||= { west: {}, centraal: {} };
    guestsNextWeeks[r.mondayKey][r.location] ||= {};
    guestsNextWeeks[r.mondayKey][r.location][r.day] ||= { lunch: 0, dinner: 0 };
    if (r.meal === 'lunch') guestsNextWeeks[r.mondayKey][r.location][r.day].lunch = r.count;
    if (r.meal === 'dinner') guestsNextWeeks[r.mondayKey][r.location][r.day].dinner = r.count;
  }

  const sc = await prisma.storageConfig.findUnique({ where: { id: 'default' } });
  const storageConfig = (sc?.config as unknown as StorageConfig) || { west: [], centraal: [] };

  const ke = await prisma.kitchenEquipment.findUnique({ where: { id: 'default' } });
  const kitchenEquipment: KitchenEquipment = ke
    ? {
        pots: (ke.pots as unknown) as number[],
        gasBurners: ke.gasBurners,
        inductionBurners: ke.inductionBurners,
        bigBurnerThreshold: ke.bigBurnerThreshold,
      }
    : { pots: [140, 140, 100, 100, 80, 80, 60, 60, 40, 40], gasBurners: 4, inductionBurners: 4, bigBurnerThreshold: 80 };

  return { batches, caterings, guestsBase, guestsNextWeeks, storageConfig, kitchenEquipment };
}

// ── Resolve guest count using the same fallback as core.ts:getGuests ──────
//
// Order: current week → guestsNextWeeks → predictions → base.
// Without telemetry-derived predictions, we just do base → nextWeeks.

function resolveGuests(
  state: RawState,
  todayIso: string,
  loc: 'west' | 'centraal',
  dateIso: string,
  meal: 'lunch' | 'dinner',
): number {
  const dayName = dateToDayName(dateIso);
  const targetWeek = weekMondayIso(dateIso);
  const currentWeek = weekMondayIso(todayIso);

  if (targetWeek === currentWeek) {
    return state.guestsBase[loc]?.[dayName]?.[meal] ?? 0;
  }
  const wk = state.guestsNextWeeks[targetWeek];
  if (wk?.[loc]?.[dayName]?.[meal] !== undefined) {
    return wk[loc][dayName][meal];
  }
  // Final fallback: base
  return state.guestsBase[loc]?.[dayName]?.[meal] ?? 0;
}

function buildGuestsLookup(state: RawState, todayIso: string, days = 14): GuestsLookup {
  const lookup: GuestsLookup = {};
  const start = isoToDate(todayIso);
  for (let i = -3; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = dateToIso(d);
    lookup[iso] = {
      west: {
        lunch: resolveGuests(state, todayIso, 'west', iso, 'lunch'),
        dinner: resolveGuests(state, todayIso, 'west', iso, 'dinner'),
      },
      centraal: {
        lunch: resolveGuests(state, todayIso, 'centraal', iso, 'lunch'),
        dinner: resolveGuests(state, todayIso, 'centraal', iso, 'dinner'),
      },
    };
  }
  return lookup;
}

// ── Fixture builders ──────────────────────────────────────────────────────

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

interface PartialFixture {
  name: string;
  description: string;
  today: string;
  state: RawState;
}

function finalize(p: PartialFixture): Fixture {
  return {
    name: p.name,
    description: p.description,
    today: p.today,
    batches: p.state.batches,
    caterings: p.state.caterings,
    guestsBase: p.state.guestsBase,
    guestsNextWeeks: p.state.guestsNextWeeks,
    guestsPredictions: { west: {}, centraal: {} },
    guestsLookup: buildGuestsLookup(p.state, p.today),
    kitchenEquipment: p.state.kitchenEquipment,
    storageConfig: p.state.storageConfig,
  };
}

/**
 * For sliding-today fixtures: prune batches whose ALL services are far in the
 * past (> 30 days before today), to keep fixture files small. Also strip
 * future services so the planner has work to do.
 */
function pruneForToday(state: RawState, todayIso: string): RawState {
  const cutoff = new Date(isoToDate(todayIso).getTime() - 30 * 86400000);
  const cutoffIso = dateToIso(cutoff);
  const out = deepClone(state);
  out.batches = out.batches.filter(b => {
    if (!b.cookDate) return true; // keep unscheduled
    // Convert DD/MM/YYYY → YYYY-MM-DD for compare
    const cd = b.cookDate;
    const m = cd.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const cookIso = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    if (cookIso && cookIso < cutoffIso) {
      // Old batches — drop entirely
      return false;
    }
    return true;
  });
  // Strip services that are in the future from today (so the solver has work)
  for (const b of out.batches) {
    b.services = (b.services || []).filter(s => s.date < todayIso);
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL || '';
  if (!url) {
    console.error('Set DATABASE_URL (should point at staging, not prod).');
    process.exit(1);
  }
  assertNotProd(url);
  console.log(`Connecting to ${url.split('@')[1] || url}…`);

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  let state: RawState;
  try {
    state = await loadState(prisma);
  } finally {
    await prisma.$disconnect();
  }

  console.log(`Loaded: ${state.batches.length} batches, ${state.caterings.length} caterings, ` +
    `${Object.keys(state.guestsNextWeeks).length} weeks of guest predictions, ` +
    `${state.kitchenEquipment.pots.length} pots, storage cfg keys: ${Object.keys(state.storageConfig).length}`);

  // Find a sensible base "today" — pick a date that has cooked batches both
  // before and after, so all 5 sliding scenarios have realistic state.
  const cookDateIsos = state.batches
    .map(b => b.cookDate)
    .filter((c): c is string => !!c)
    .map(c => {
      const m = c.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    })
    .filter((c): c is string => c !== null)
    .sort();

  const median = cookDateIsos[Math.floor(cookDateIsos.length / 2)] || dateToIso(new Date());
  console.log(`Using base today=${median} (median cookDate)`);

  if (!fs.existsSync(FIXTURES_DIR)) fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  // ── 5 sliding-today fixtures ────────────────────────────────────────────
  // Anchor "today" at the median cookDate, then offset by -3, -1, +1, +3, +5
  // days to capture different planning horizons.

  const slidingOffsets: Array<{ offset: number; tag: string }> = [
    { offset: -3, tag: '01-sliding-mon' },
    { offset: -1, tag: '02-sliding-wed' },
    { offset: 0, tag: '03-sliding-thu' },
    { offset: 2, tag: '04-sliding-sat' },
    { offset: 5, tag: '05-sliding-tue-next' },
  ];

  const baseDate = isoToDate(median);
  for (const { offset, tag } of slidingOffsets) {
    const today = dateToIso(new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + offset));
    const fix = finalize({
      name: tag,
      description: `Sliding-today fixture: today=${today} (${dateToDayName(today)}), offset ${offset}d from median cookDate`,
      today,
      state: pruneForToday(state, today),
    });
    const file = path.join(FIXTURES_DIR, `${tag}.json`);
    fs.writeFileSync(file, JSON.stringify(fix, null, 2));
    console.log(`  wrote ${tag} (${fix.batches.length} batches)`);
  }

  // ── 5 edge-case fixtures ────────────────────────────────────────────────
  // All anchored at today = median + 1 (a "Friday" so weekend rhythm kicks in).

  const edgeToday = dateToIso(new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1));

  // 06: empty week — no future-scheduled cooks, no future services
  {
    const s = pruneForToday(state, edgeToday);
    s.batches = s.batches.filter(b => {
      const m = b.cookDate?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      const cookIso = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
      return !cookIso || cookIso < edgeToday;
    });
    // Also clear services in the future
    for (const b of s.batches) b.services = b.services.filter(svc => svc.date < edgeToday);
    const fix = finalize({
      name: '06-edge-empty-week',
      description: 'Empty future week: nothing scheduled past today, only past cooks remain',
      today: edgeToday,
      state: s,
    });
    fs.writeFileSync(path.join(FIXTURES_DIR, '06-edge-empty-week.json'), JSON.stringify(fix, null, 2));
    console.log(`  wrote 06-edge-empty-week (${fix.batches.length} batches)`);
  }

  // 07: surplus stuck — pick the largest cooked batch in window and inflate stock by 40L
  {
    const s = pruneForToday(state, edgeToday);
    const cooked = s.batches.filter(b => b.stock > 0 && (b.type === 'Soup' || b.type === 'Main course'));
    if (cooked.length > 0) {
      cooked.sort((a, b) => b.stock - a.stock);
      cooked[0].stock += 40;
      cooked[0].cookNotes = (cooked[0].cookNotes || '') + ' [bench: +40L surplus]';
    }
    const fix = finalize({
      name: '07-edge-surplus-stuck',
      description: `Over-cooked: largest cooked batch has +40L surplus (now ${cooked[0]?.stock || 0}L)`,
      today: edgeToday,
      state: s,
    });
    fs.writeFileSync(path.join(FIXTURES_DIR, '07-edge-surplus-stuck.json'), JSON.stringify(fix, null, 2));
    console.log(`  wrote 07-edge-surplus-stuck (${fix.batches.length} batches)`);
  }

  // 08: stockout pressure — bump all guest counts by 50%, also halve cooked stock
  {
    const s = pruneForToday(state, edgeToday);
    for (const loc of ['west', 'centraal'] as const) {
      for (const day of DAYS) {
        const cell = s.guestsBase[loc]?.[day];
        if (cell) {
          cell.lunch = Math.round(cell.lunch * 1.5);
          cell.dinner = Math.round(cell.dinner * 1.5);
        }
      }
    }
    for (const b of s.batches) {
      if (b.stock > 0) b.stock = Math.round(b.stock * 0.5 * 10) / 10;
    }
    const fix = finalize({
      name: '08-edge-stockout-pressure',
      description: 'Demand inflated +50%, cooked stock halved — solver must cope with under-supply',
      today: edgeToday,
      state: s,
    });
    fs.writeFileSync(path.join(FIXTURES_DIR, '08-edge-stockout-pressure.json'), JSON.stringify(fix, null, 2));
    console.log(`  wrote 08-edge-stockout-pressure (${fix.batches.length} batches)`);
  }

  // 09: frozen rescue — mark 2 cooked batches as Frozen, deplete two others
  {
    const s = pruneForToday(state, edgeToday);
    const cooked = s.batches.filter(b => b.stock > 0 && (b.type === 'Soup' || b.type === 'Main course'));
    cooked.sort((a, b) => b.stock - a.stock);
    if (cooked[0]) cooked[0].storage = 'Frozen';
    if (cooked[1]) cooked[1].storage = 'Frozen';
    if (cooked[2]) cooked[2].stock = 0.5;
    if (cooked[3]) cooked[3].stock = 0.5;
    const fix = finalize({
      name: '09-edge-frozen-rescue',
      description: 'Two largest cooked batches are now Frozen; two others nearly depleted — frozen rescue path',
      today: edgeToday,
      state: s,
    });
    fs.writeFileSync(path.join(FIXTURES_DIR, '09-edge-frozen-rescue.json'), JSON.stringify(fix, null, 2));
    console.log(`  wrote 09-edge-frozen-rescue (${fix.batches.length} batches)`);
  }

  // 10: catering-heavy — synthesize 3 caterings with high guest counts in window
  {
    const s = pruneForToday(state, edgeToday);
    const startD = isoToDate(edgeToday);
    const synthDates: string[] = [
      dateToIso(new Date(startD.getFullYear(), startD.getMonth(), startD.getDate() + 2)),
      dateToIso(new Date(startD.getFullYear(), startD.getMonth(), startD.getDate() + 4)),
      dateToIso(new Date(startD.getFullYear(), startD.getMonth(), startD.getDate() + 7)),
    ];
    // Find 3 batches in window to assign to caterings
    const futureCooks = s.batches.filter(b => {
      if (b.type !== 'Soup' && b.type !== 'Main course') return false;
      const m = b.cookDate?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      const cookIso = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
      return cookIso && cookIso >= edgeToday;
    });
    // If too few future cooks, use any cooked batches with stock
    const candidates = futureCooks.length >= 3 ? futureCooks : s.batches.filter(b =>
      (b.type === 'Soup' || b.type === 'Main course') && (b.stock > 0 || futureCooks.includes(b))
    );
    for (let i = 0; i < 3 && i < candidates.length; i++) {
      const b = candidates[i];
      const cat: Catering = {
        id: `bench-cat-${i + 1}`,
        name: `Bench catering ${i + 1}`,
        date: synthDates[i],
        guestCount: 80 + i * 20, // 80, 100, 120
        deliveryMode: 'pickup',
        dishes: [{ dishId: b.id, name: b.name, type: b.type }],
        logisticsNotes: '',
        createdAt: new Date().toISOString(),
      };
      s.caterings.push(cat);
    }
    const fix = finalize({
      name: '10-edge-catering-heavy',
      description: `3 synthetic caterings (80, 100, 120 guests) at +2d, +4d, +7d — competes with regular service demand`,
      today: edgeToday,
      state: s,
    });
    fs.writeFileSync(path.join(FIXTURES_DIR, '10-edge-catering-heavy.json'), JSON.stringify(fix, null, 2));
    console.log(`  wrote 10-edge-catering-heavy (${fix.batches.length} batches, ${fix.caterings.length} caterings)`);
  }

  console.log(`\nDone. Wrote 10 fixtures to ${FIXTURES_DIR}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
