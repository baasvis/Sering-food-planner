const router = require('express').Router();
const { prisma } = require('../lib/db');

// ── Guest history helpers ──

function guestHistoryToJson(histRows, metaRows) {
  const result = {};
  for (const row of histRows) {
    const loc = row.location;
    const meal = row.meal;
    if (!result[loc]) result[loc] = {};
    if (!result[loc][meal]) result[loc][meal] = {};
    result[loc][meal][row.date] = row.count;
  }
  for (const row of metaRows) {
    if (row.key === 'deviceMap') {
      try { result.deviceMap = JSON.parse(row.value); } catch (e) { result.deviceMap = {}; }
    } else if (row.key === 'lastUpdated') {
      result.lastUpdated = row.value;
    }
  }
  return result;
}

// ── Next weeks helpers ──

function guestsNextWeeksToJson(rows) {
  const result = {};
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

router.get('/guest-history', async (req, res) => {
  try {
    const [histRows, metaRows] = await Promise.all([
      prisma.guestHistory.findMany(),
      prisma.guestHistoryMeta.findMany(),
    ]);
    res.json(guestHistoryToJson(histRows, metaRows));
  } catch (e) {
    console.error('guest-history read error:', e.message);
    res.json({});
  }
});

router.post('/guest-history', async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    await prisma.$transaction(async (tx) => {
      const [existingHist, existingMeta] = await Promise.all([
        tx.guestHistory.findMany(),
        tx.guestHistoryMeta.findMany(),
      ]);
      const existing = guestHistoryToJson(existingHist, existingMeta);

      // Deep merge incoming data
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

      // Rebuild flat rows and write
      const histData = [];
      for (const loc of ['west', 'centraal']) {
        if (!existing[loc]) continue;
        for (const meal of ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner']) {
          if (!existing[loc][meal]) continue;
          for (const [date, count] of Object.entries(existing[loc][meal])) {
            histData.push({ location: loc, meal, date, count: parseInt(count) || 0 });
          }
        }
      }

      await tx.guestHistory.deleteMany();
      if (histData.length > 0) {
        await tx.guestHistory.createMany({ data: histData });
      }

      // Upsert meta
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
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('guest-history write error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/guests-next-weeks', async (req, res) => {
  try {
    const rows = await prisma.guestsNextWeeks.findMany();
    res.json(guestsNextWeeksToJson(rows));
  } catch (e) {
    console.error('guests-next-weeks read error:', e.message);
    res.json({});
  }
});

router.post('/guests-next-weeks', async (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    // Flatten nested JSON to rows
    const rows = [];
    for (const [mondayKey, locations] of Object.entries(data)) {
      if (typeof locations !== 'object') continue;
      for (const [loc, days] of Object.entries(locations)) {
        if (typeof days !== 'object') continue;
        for (const [day, meals] of Object.entries(days)) {
          if (typeof meals !== 'object') continue;
          for (const [meal, count] of Object.entries(meals)) {
            rows.push({ mondayKey, location: loc, day, meal, count: parseInt(count) || 0 });
          }
        }
      }
    }

    await prisma.$transaction([
      prisma.guestsNextWeeks.deleteMany(),
      prisma.guestsNextWeeks.createMany({ data: rows }),
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error('guests-next-weeks write error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
