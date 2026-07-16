import express, { Request, Response } from 'express';
import { prisma, withWriteLock } from '../lib/db';
import { asyncHandler } from '../lib/config';
import { broadcast } from './events';
import type { GuestHistory, GuestHistoryMeta, GuestsNextWeeks } from '@prisma/client';

const router = express.Router();

// ── Type definitions for nested JSON structures ──

// Guest history is a mixed bag: location data + metadata fields.
// Using Record<string, unknown> with explicit getters is cleaner than a conflicting index signature.
type GuestHistoryJson = Record<string, unknown>;

interface FlowDistribution {
  [location: string]: {
    [meal: string]: {
      [dayOfWeek: string]: Record<string, number>;
    };
  };
}

// ── Guest history helpers ──

function guestHistoryToJson(histRows: GuestHistory[], metaRows: GuestHistoryMeta[]): GuestHistoryJson {
  const result: GuestHistoryJson = {};
  for (const row of histRows) {
    const loc = row.location;
    const meal = row.meal;
    if (!result[loc]) result[loc] = {};
    const locData = result[loc] as Record<string, Record<string, number>>;
    if (!locData[meal]) locData[meal] = {};
    locData[meal][row.date] = row.count;
  }
  for (const row of metaRows) {
    if (row.key === 'deviceMap') {
      try { result.deviceMap = JSON.parse(row.value); } catch (_e) { result.deviceMap = {}; }
    } else if (row.key === 'lastUpdated') {
      result.lastUpdated = row.value;
    } else if (row.key === 'flowDistribution') {
      try { result.flowDistribution = JSON.parse(row.value); } catch (_e) { result.flowDistribution = null; }
    }
  }
  return result;
}

// ── Next weeks helpers ──

interface NextWeeksJson {
  [mondayKey: string]: {
    [location: string]: {
      [day: string]: {
        [meal: string]: number;
      };
    };
  };
}

function guestsNextWeeksToJson(rows: GuestsNextWeeks[]): NextWeeksJson {
  const result: NextWeeksJson = {};
  for (const row of rows) {
    const mk = row.mondayKey;
    if (!result[mk]) result[mk] = {};
    if (!result[mk][row.location]) result[mk][row.location] = {};
    if (!result[mk][row.location][row.day]) result[mk][row.location][row.day] = {};
    result[mk][row.location][row.day][row.meal] = row.count;
  }
  return result;
}

// ── Routes ──

router.get('/guest-history', asyncHandler(async (_req: Request, res: Response) => {
  const [histRows, metaRows] = await Promise.all([
    prisma.guestHistory.findMany(),
    prisma.guestHistoryMeta.findMany(),
  ]);
  // Cache for 60s: history only changes on POS upload, but dashboard/planner
  // poll this endpoint (74 calls over 9 screen views — insight #33).
  // POST /guest-history invalidates implicitly (new data pushes a 200 not 304).
  res.set('Cache-Control', 'private, max-age=60');
  res.json(guestHistoryToJson(histRows, metaRows));
}));

router.post('/guest-history', asyncHandler(async (req: Request, res: Response) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Expected object' });

  // Two POS devices uploading concurrently used to race: each read the existing
  // history, merged its own data, and the later write wiped the earlier merge.
  // withWriteLock serialises the read-merge-write cycle.
  await withWriteLock(async () => {
  await prisma.$transaction(async (tx) => {
    const [existingHist, existingMeta] = await Promise.all([
      tx.guestHistory.findMany(),
      tx.guestHistoryMeta.findMany(),
    ]);
    const existing = guestHistoryToJson(existingHist, existingMeta);

    // DELIBERATELY permanent-only: POS history ingest doesn't exist for
    // temporary event locations (v1) — their guest counts are entered by hand
    // on the Guests screen. The scoped deleteMany below already protects any
    // event-keyed rows the same way it protects the Hub's 'testtafel' rows.
    for (const loc of ['west', 'centraal']) {
      if (!incoming[loc]) continue;
      if (!existing[loc]) existing[loc] = {};
      const existLoc = existing[loc] as Record<string, Record<string, number>>;
      const incomingLoc = incoming[loc] as Record<string, Record<string, number>>;
      for (const meal of ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner']) {
        if (!incomingLoc[meal]) continue;
        if (!existLoc[meal]) existLoc[meal] = {};
        Object.assign(existLoc[meal], incomingLoc[meal]);
      }
    }
    if (incoming.deviceMap) {
      existing.deviceMap = { ...(existing.deviceMap || {}), ...incoming.deviceMap };
    }
    existing.lastUpdated = new Date().toISOString();

    const histData: Array<{ location: string; meal: string; date: string; count: number }> = [];
    for (const loc of ['west', 'centraal']) {
      if (!existing[loc]) continue;
      const locData = existing[loc] as Record<string, Record<string, number>>;
      for (const meal of ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner']) {
        if (!locData[meal]) continue;
        for (const [date, count] of Object.entries(locData[meal])) {
          histData.push({ location: loc, meal, date, count: parseInt(String(count)) || 0 });
        }
      }
    }

    // The Sering Hub writes 'testtafel' GuestHistory rows to this shared
    // table. This CSV-upload path owns only 'west'/'centraal' — scope the
    // wipe to those so an upload can't destroy Hub-written testtafel data
    // (Hub plan §1.14). The rebuild loop above only emits west/centraal
    // rows, so the scoped delete + createMany stay consistent.
    await tx.guestHistory.deleteMany({ where: { location: { in: ['west', 'centraal'] } } });
    if (histData.length > 0) {
      await tx.guestHistory.createMany({ data: histData });
    }

    const deviceMapJson = JSON.stringify(existing.deviceMap || {});
    await tx.guestHistoryMeta.upsert({
      where: { key: 'deviceMap' },
      create: { key: 'deviceMap', value: deviceMapJson },
      update: { value: deviceMapJson },
    });
    const lastUpdated = existing.lastUpdated as string;
    await tx.guestHistoryMeta.upsert({
      where: { key: 'lastUpdated' },
      create: { key: 'lastUpdated', value: lastUpdated },
      update: { value: lastUpdated },
    });

    if (incoming.flowDistribution) {
      let existingFlow: FlowDistribution = {};
      try {
        const row = await tx.guestHistoryMeta.findUnique({ where: { key: 'flowDistribution' } });
        if (row) existingFlow = JSON.parse(row.value) as FlowDistribution;
      } catch (_e) { /* ignore */ }
      for (const loc of Object.keys(incoming.flowDistribution)) {
        if (!existingFlow[loc]) existingFlow[loc] = {};
        for (const meal of Object.keys(incoming.flowDistribution[loc])) {
          if (!existingFlow[loc][meal]) existingFlow[loc][meal] = {};
          for (const dow of Object.keys(incoming.flowDistribution[loc][meal])) {
            const newBuckets = incoming.flowDistribution[loc][meal][dow] as Record<string, number>;
            const oldBuckets = existingFlow[loc][meal][dow] || {};
            const merged: Record<string, number> = {};
            const allKeys = new Set([...Object.keys(oldBuckets), ...Object.keys(newBuckets)]);
            for (const k of allKeys) {
              const o = parseFloat(String(oldBuckets[k])) || 0;
              const n = parseFloat(String(newBuckets[k])) || 0;
              if (o > 0 && n > 0) merged[k] = Math.round((o * 0.3 + n * 0.7) * 10000) / 10000;
              else merged[k] = n || o;
            }
            const total = Object.values(merged).reduce((s, v) => s + v, 0);
            if (total > 0) {
              for (const k of Object.keys(merged)) merged[k] = Math.round((merged[k] / total) * 10000) / 10000;
            }
            existingFlow[loc][meal][dow] = merged;
          }
        }
      }
      await tx.guestHistoryMeta.upsert({
        where: { key: 'flowDistribution' },
        create: { key: 'flowDistribution', value: JSON.stringify(existingFlow) },
        update: { value: JSON.stringify(existingFlow) },
      });
    }
  });
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  // Reload trigger — guest history mutations are too varied (per-day buckets +
  // metadata + flow distribution) to ship through SSE; receivers re-fetch.
  broadcast(user.email, 'patch', { user: user.name, guestHistoryReload: true });
  res.json({ ok: true });
}));

router.get('/guests-next-weeks', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.guestsNextWeeks.findMany();
  // Same reasoning as /guest-history above — polled from dashboard/planner.
  res.set('Cache-Control', 'private, max-age=60');
  res.json(guestsNextWeeksToJson(rows));
}));

router.post('/guests-next-weeks', asyncHandler(async (req: Request, res: Response) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });

  const rows: Array<{ mondayKey: string; location: string; day: string; meal: string; count: number }> = [];
  const mondayKeysInBody = new Set<string>();
  for (const [mondayKey, locations] of Object.entries(data as Record<string, Record<string, Record<string, Record<string, number>>>>)) {
    if (typeof locations !== 'object') continue;
    mondayKeysInBody.add(mondayKey);
    for (const [loc, days] of Object.entries(locations)) {
      if (typeof days !== 'object') continue;
      for (const [day, meals] of Object.entries(days)) {
        if (typeof meals !== 'object') continue;
        for (const [meal, count] of Object.entries(meals)) {
          rows.push({ mondayKey, location: loc, day, meal, count: parseInt(String(count)) || 0 });
        }
      }
    }
  }

  // Scope the deleteMany to ONLY the mondayKeys in this request — previously
  // this endpoint did `deleteMany()` over the whole table, so a client sending
  // one week's data would wipe every other week. (Audit §1.7.)
  await withWriteLock(async () => {
    await prisma.$transaction([
      prisma.guestsNextWeeks.deleteMany({
        where: { mondayKey: { in: Array.from(mondayKeysInBody) } },
      }),
      prisma.guestsNextWeeks.createMany({ data: rows }),
    ]);
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  // Echo the body — frontend merges by mondayKey so unaffected weeks survive.
  broadcast(user.email, 'patch', { user: user.name, guestsNextWeeks: data });
  res.json({ ok: true });
}));

export default router;
