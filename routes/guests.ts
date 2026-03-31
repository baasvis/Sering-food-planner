import express, { Request, Response } from 'express';
import { prisma } from '../lib/db';
import { errMsg } from '../lib/config';

const router = express.Router();

// ── Guest history helpers ──

function guestHistoryToJson(histRows: any[], metaRows: any[]) {
  const result: Record<string, any> = {};
  for (const row of histRows) {
    const loc = row.location;
    const meal = row.meal;
    if (!result[loc]) result[loc] = {};
    if (!result[loc][meal]) result[loc][meal] = {};
    result[loc][meal][row.date] = row.count;
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

function guestsNextWeeksToJson(rows: any[]) {
  const result: Record<string, any> = {};
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

router.get('/guest-history', async (_req: Request, res: Response) => {
  try {
    const [histRows, metaRows] = await Promise.all([
      prisma.guestHistory.findMany(),
      prisma.guestHistoryMeta.findMany(),
    ]);
    res.json(guestHistoryToJson(histRows, metaRows));
  } catch (e: unknown) {
    console.error('guest-history read error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

router.post('/guest-history', async (req: Request, res: Response) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    await prisma.$transaction(async (tx) => {
      const [existingHist, existingMeta] = await Promise.all([
        tx.guestHistory.findMany(),
        tx.guestHistoryMeta.findMany(),
      ]);
      const existing = guestHistoryToJson(existingHist, existingMeta);

      for (const loc of ['west', 'centraal']) {
        if (!incoming[loc]) continue;
        if (!existing[loc]) existing[loc] = {};
        for (const meal of ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner']) {
          if (!incoming[loc][meal]) continue;
          if (!existing[loc][meal]) existing[loc][meal] = {};
          Object.assign(existing[loc][meal], incoming[loc][meal]);
        }
      }
      if (incoming.deviceMap) {
        existing.deviceMap = { ...(existing.deviceMap || {}), ...incoming.deviceMap };
      }
      existing.lastUpdated = new Date().toISOString();

      const histData: Array<{ location: string; meal: string; date: string; count: number }> = [];
      for (const loc of ['west', 'centraal']) {
        if (!existing[loc]) continue;
        for (const meal of ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner']) {
          if (!existing[loc][meal]) continue;
          for (const [date, count] of Object.entries(existing[loc][meal])) {
            histData.push({ location: loc, meal, date, count: parseInt(count as string) || 0 });
          }
        }
      }

      await tx.guestHistory.deleteMany();
      if (histData.length > 0) {
        await tx.guestHistory.createMany({ data: histData });
      }

      await tx.guestHistoryMeta.upsert({
        where: { key: 'deviceMap' },
        create: { key: 'deviceMap', value: JSON.stringify(existing.deviceMap || {}) },
        update: { value: JSON.stringify(existing.deviceMap || {}) },
      });
      await tx.guestHistoryMeta.upsert({
        where: { key: 'lastUpdated' },
        create: { key: 'lastUpdated', value: existing.lastUpdated },
        update: { value: existing.lastUpdated },
      });

      if (incoming.flowDistribution) {
        let existingFlow: Record<string, any> = {};
        try {
          const row = await tx.guestHistoryMeta.findUnique({ where: { key: 'flowDistribution' } });
          if (row) existingFlow = JSON.parse(row.value);
        } catch (_e) { /* ignore */ }
        for (const loc of Object.keys(incoming.flowDistribution)) {
          if (!existingFlow[loc]) existingFlow[loc] = {};
          for (const meal of Object.keys(incoming.flowDistribution[loc])) {
            if (!existingFlow[loc][meal]) existingFlow[loc][meal] = {};
            for (const dow of Object.keys(incoming.flowDistribution[loc][meal])) {
              const newBuckets = incoming.flowDistribution[loc][meal][dow];
              const oldBuckets = existingFlow[loc][meal][dow] || {};
              const merged: Record<string, number> = {};
              const allKeys = new Set([...Object.keys(oldBuckets), ...Object.keys(newBuckets)]);
              for (const k of allKeys) {
                const o = parseFloat(oldBuckets[k]) || 0;
                const n = parseFloat(newBuckets[k]) || 0;
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
    res.json({ ok: true });
  } catch (e: unknown) {
    console.error('guest-history write error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

router.get('/guests-next-weeks', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.guestsNextWeeks.findMany();
    res.json(guestsNextWeeksToJson(rows));
  } catch (e: unknown) {
    console.error('guests-next-weeks read error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

router.post('/guests-next-weeks', async (req: Request, res: Response) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    const rows: Array<{ mondayKey: string; location: string; day: string; meal: string; count: number }> = [];
    for (const [mondayKey, locations] of Object.entries(data as Record<string, any>)) {
      if (typeof locations !== 'object') continue;
      for (const [loc, days] of Object.entries(locations as Record<string, any>)) {
        if (typeof days !== 'object') continue;
        for (const [day, meals] of Object.entries(days as Record<string, any>)) {
          if (typeof meals !== 'object') continue;
          for (const [meal, count] of Object.entries(meals as Record<string, any>)) {
            rows.push({ mondayKey, location: loc, day, meal, count: parseInt(count as string) || 0 });
          }
        }
      }
    }

    await prisma.$transaction([
      prisma.guestsNextWeeks.deleteMany(),
      prisma.guestsNextWeeks.createMany({ data: rows }),
    ]);
    res.json({ ok: true });
  } catch (e: unknown) {
    console.error('guests-next-weeks write error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

export default router;
