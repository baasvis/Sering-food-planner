const router = require('express').Router();
const { dbReadAll, dbWriteAll, dbAppendLog, getDefaultGuests, validateDishes, validateGuests, withWriteLock } = require('../lib/sheets');

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

    await withWriteLock(() => dbWriteAll(dishes, guests, caterings, transportItems));

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'save', `${dishes.length} dishes`);

    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
