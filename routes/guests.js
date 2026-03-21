const router = require('express').Router();
const { CONFIG } = require('../lib/config');
const { getSheetsClient, readTab, writeTab, ensureTabsExist, withWriteLock, GUEST_HISTORY_HEADERS, GUEST_HISTORY_META_HEADERS, GUESTS_NEXT_WEEKS_HEADERS } = require('../lib/sheets');

// ── Guest history helpers ──

function guestHistoryRowsToJson(histRows, metaRows) {
  const result = {};
  for (const row of histRows) {
    const loc = row.location;
    const meal = row.meal;
    if (!result[loc]) result[loc] = {};
    if (!result[loc][meal]) result[loc][meal] = {};
    result[loc][meal][row.date] = parseInt(row.count) || 0;
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

function guestHistoryJsonToRows(data) {
  const rows = [];
  for (const loc of ['west', 'centraal']) {
    if (!data[loc]) continue;
    for (const meal of ['lunch', 'dinner', 'staff', 'staff_lunch', 'staff_dinner']) {
      if (!data[loc][meal]) continue;
      for (const [date, count] of Object.entries(data[loc][meal])) {
        rows.push([loc, meal, date, count]);
      }
    }
  }
  return rows;
}

// ── Next weeks helpers ──

function guestsNextWeeksRowsToJson(rows) {
  const result = {};
  for (const row of rows) {
    const mk = row.monday_key;
    if (!result[mk]) result[mk] = {};
    if (!result[mk][row.location]) result[mk][row.location] = {};
    if (!result[mk][row.location][row.day]) result[mk][row.location][row.day] = {};
    result[mk][row.location][row.day][row.meal] = parseInt(row.count) || 0;
  }
  return result;
}

function guestsNextWeeksJsonToRows(data) {
  const rows = [];
  for (const [mondayKey, locations] of Object.entries(data)) {
    if (typeof locations !== 'object') continue;
    for (const [loc, days] of Object.entries(locations)) {
      if (typeof days !== 'object') continue;
      for (const [day, meals] of Object.entries(days)) {
        if (typeof meals !== 'object') continue;
        for (const [meal, count] of Object.entries(meals)) {
          rows.push([mondayKey, loc, day, meal, count]);
        }
      }
    }
  }
  return rows;
}

// ── Routes ──

router.get('/guest-history', async (req, res) => {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return res.json({});
  try {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['guest_history', 'guest_history_meta']);
    const [histRows, metaRows] = await Promise.all([
      readTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history'),
      readTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history_meta'),
    ]);
    res.json(guestHistoryRowsToJson(histRows, metaRows));
  } catch (e) {
    console.error('guest-history read error:', e.message);
    res.json({});
  }
});

router.post('/guest-history', async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['guest_history', 'guest_history_meta']);

      const [existingHistRows, existingMetaRows] = await Promise.all([
        readTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history'),
        readTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history_meta'),
      ]);
      const existing = guestHistoryRowsToJson(existingHistRows, existingMetaRows);

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

      const histDataRows = guestHistoryJsonToRows(existing);
      const metaDataRows = [
        ['deviceMap', JSON.stringify(existing.deviceMap || {})],
        ['lastUpdated', existing.lastUpdated],
      ];
      await Promise.all([
        writeTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history', GUEST_HISTORY_HEADERS, histDataRows),
        writeTab(sheets, CONFIG.DB_SHEET_ID, 'guest_history_meta', GUEST_HISTORY_META_HEADERS, metaDataRows),
      ]);
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('guest-history write error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/guests-next-weeks', async (req, res) => {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return res.json({});
  try {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['guests_next_weeks']);
    const rows = await readTab(sheets, CONFIG.DB_SHEET_ID, 'guests_next_weeks');
    res.json(guestsNextWeeksRowsToJson(rows));
  } catch (e) {
    console.error('guests-next-weeks read error:', e.message);
    res.json({});
  }
});

router.post('/guests-next-weeks', async (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['guests_next_weeks']);
      const rows = guestsNextWeeksJsonToRows(data);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'guests_next_weeks', GUESTS_NEXT_WEEKS_HEADERS, rows);
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('guests-next-weeks write error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
