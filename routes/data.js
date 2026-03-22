const router = require('express').Router();
const { dbReadAll, dbWriteAll, dbAppendLog, getDefaultGuests, validateDishes, validateGuests, withWriteLock, dbWriteDishes, dbWriteGuests, dbWriteCaterings, dbWriteTransportItems } = require('../lib/db');

router.get('/', async (req, res) => {
  try { res.json(await dbReadAll()); }
  catch (e) { res.status(500).json({ error: e.message }); }
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

    await dbWriteAll(dishes, guests, caterings, transportItems);

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'save', `${dishes.length} dishes`);

    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
