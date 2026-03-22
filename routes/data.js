const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../lib/config');
const { logError } = require('../lib/logger');
const { dbReadAll, dbWriteAll, dbAppendLog, getDefaultGuests, validateDishes, validateGuests, validateCaterings, withWriteLock, dbWriteDishes, dbWriteGuests, dbWriteCaterings, dbWriteTransportItems } = require('../lib/db');

const DEV_SEED_PATH = path.join(__dirname, '..', 'seeds', 'dev-data.json');

router.get('/', async (req, res) => {
  try {
    const data = await dbReadAll();
    if (!CONFIG.GOOGLE_CLIENT_ID && (!data.dishes || data.dishes.length === 0) && fs.existsSync(DEV_SEED_PATH)) {
      const seed = JSON.parse(fs.readFileSync(DEV_SEED_PATH, 'utf8'));
      return res.json({ ...data, ...seed });
    }
    res.json(data);
  }
  catch (e) { logError('data', e, req); res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const dishes = req.body.dishes || [];
    const guests = req.body.guests || getDefaultGuests();
    const caterings = req.body.caterings || [];
    const transportItems = req.body.transportItems || [];

    const dishErr = validateDishes(dishes);
    if (dishErr) return res.status(400).json({ error: dishErr });
    const guestErr = validateGuests(guests);
    if (guestErr) return res.status(400).json({ error: guestErr });
    if (caterings.length > 0) {
      const catErr = validateCaterings(caterings);
      if (catErr) return res.status(400).json({ error: catErr });
    }

    await dbWriteAll(dishes, guests, caterings, transportItems);

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'save', `${dishes.length} dishes`);

    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) { logError('data', e, req); res.status(500).json({ error: e.message }); }
});

// ── Concurrent save detection ──
const CONCURRENT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
let _lastSave = null; // { email, name, at }

function checkConcurrent(user) {
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

router.post('/patch', async (req, res) => {
  try {
    const { dishes, deletedDishes, guests, caterings, deletedCaterings,
            transportItems, deletedTransportItems } = req.body;

    await withWriteLock(async () => {
      const current = await dbReadAll();

      // Merge dishes
      if ((dishes && dishes.length) || (deletedDishes && deletedDishes.length)) {
        const dishMap = new Map(current.dishes.map(d => [d.id, d]));
        if (deletedDishes) deletedDishes.forEach(id => dishMap.delete(id));
        if (dishes && dishes.length) {
          const dishErr = validateDishes(dishes);
          if (dishErr) throw new Error(dishErr);
          dishes.forEach(d => dishMap.set(d.id, d));
        }
        await dbWriteDishes([...dishMap.values()]);
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
        const catMap = new Map(current.caterings.map(c => [c.id, c]));
        if (deletedCaterings) deletedCaterings.forEach(id => catMap.delete(id));
        if (caterings) caterings.forEach(c => catMap.set(c.id, c));
        await dbWriteCaterings([...catMap.values()]);
      }

      // Merge transport items
      if ((transportItems && transportItems.length) || (deletedTransportItems && deletedTransportItems.length)) {
        const trMap = new Map(current.transportItems.map(t => [t.id, t]));
        if (deletedTransportItems) deletedTransportItems.forEach(id => trMap.delete(id));
        if (transportItems) transportItems.forEach(t => trMap.set(t.id, t));
        await dbWriteTransportItems([...trMap.values()]);
      }
    });

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    const concurrent = checkConcurrent(user);
    dbAppendLog(user.email, user.name, 'patch',
      `D:${(dishes||[]).length}u/${(deletedDishes||[]).length}d G:${guests?'y':'n'} C:${(caterings||[]).length}/${(deletedCaterings||[]).length}d T:${(transportItems||[]).length}/${(deletedTransportItems||[]).length}d`);

    const result = { ok: true, savedAt: new Date().toISOString() };
    if (concurrent) result.concurrent = concurrent;
    res.json(result);
  } catch (e) {
    logError('data/patch', e, req);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
