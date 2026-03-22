const router = require('express').Router();
const fs = require('fs');
const { INGREDIENTS_SEED } = require('../lib/config');
const { prisma, dbAppendLog } = require('../lib/db');

// Mount import sub-router (upload-supplier, migrate)
router.use('/', require('./ingredients-import'));

// Helper: load ingredients from Postgres or fall back to seed file
async function loadIngredients() {
  try {
    const rows = await prisma.ingredient.findMany();
    if (rows.length > 0) return rows;
  } catch (e) {
    console.error('DB ingredient load error:', e.message);
  }
  if (fs.existsSync(INGREDIENTS_SEED)) {
    return JSON.parse(fs.readFileSync(INGREDIENTS_SEED, 'utf8'));
  }
  return [];
}

router.get('/', async (req, res) => {
  try {
    const ingredients = await loadIngredients();
    res.json(ingredients.map(ing => ({
      id: ing.id,
      name: ing.name,
      supplierName: ing.supplierName,
      types: ing.types || [],
      category: ing.category,
      unit: ing.unit,
      source: ing.supplier,
      orderCode: ing.orderCode,
      orderUnit: ing.orderUnit,
      orderUnitStandard: ing.orderUnitStandard,
      orderPrice: ing.orderPrice || '',
      orderAmount: ing.orderAmountGrams,
      unitRecalc: ing.orderAmountGrams,
      priceLevel: ing.priceLevel || '',
      pricePer100g: ing.pricePer100g || 0,
      priceAlert: ing.priceAlert || false,
      storageLocations: ing.storageLocations || {},
      stock: ing.stock || {},
      allergens: ing.allergens,
      notes: ing.notes,
      active: ing.active,
    })));
  } catch (e) {
    console.error('Ingredient DB error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Full ingredient list (for the ingredient DB editor tab)
router.get('/full', async (req, res) => {
  try {
    const ingredients = await loadIngredients();
    res.json(ingredients);
  } catch (e) {
    console.error('Ingredient DB error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bulk save all ingredients
router.post('/', async (req, res) => {
  const ingredients = req.body;
  if (!Array.isArray(ingredients)) return res.status(400).json({ error: 'Expected array' });
  try {
    await prisma.$transaction([
      prisma.ingredient.deleteMany(),
      prisma.ingredient.createMany({
        data: ingredients.map(ing => ({
          id: ing.id,
          name: ing.name || '',
          supplierName: ing.supplierName || '',
          types: ing.types || [],
          category: ing.category || '',
          unit: ing.unit || 'Grams',
          supplier: ing.supplier || '',
          orderCode: ing.orderCode || '',
          orderUnit: ing.orderUnit || '',
          orderUnitStandard: ing.orderUnitStandard || '',
          orderPrice: ing.orderPrice != null ? parseFloat(ing.orderPrice) || null : null,
          orderAmountGrams: parseFloat(ing.orderAmountGrams) || 0,
          priceLevel: ing.priceLevel || '',
          pricePer100g: parseFloat(ing.pricePer100g) || 0,
          priceHistory: ing.priceHistory || [],
          priceAlert: !!ing.priceAlert,
          storageLocations: ing.storageLocations || {},
          stock: ing.stock || {},
          nutrition: ing.nutrition || {},
          allergens: ing.allergens || '',
          notes: ing.notes || '',
          active: ing.active !== false,
        })),
      }),
    ]);
    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'ingredients-bulk', `saved ${ingredients.length} ingredients`);
    res.json({ ok: true, count: ingredients.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update stock for a single ingredient at one location
// NOTE: specific routes like /stock MUST come before /:id
router.post('/stock', async (req, res) => {
  const { ingredientId, location, amount } = req.body;
  if (!ingredientId || !location) return res.status(400).json({ error: 'ingredientId and location required' });
  try {
    const ing = await prisma.ingredient.findUnique({ where: { id: ingredientId } });
    if (!ing) return res.status(404).json({ error: 'Ingredient not found' });
    const stock = ing.stock || {};
    stock[location] = { amount: parseFloat(amount) || 0, date: new Date().toISOString().slice(0, 10) };
    await prisma.ingredient.update({ where: { id: ingredientId }, data: { stock } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk stock update (for stocktake)
router.post('/stock/bulk', async (req, res) => {
  const updates = req.body;
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'Expected array' });
  try {
    await prisma.$transaction(async (tx) => {
      for (const u of updates) {
        const ing = await tx.ingredient.findUnique({ where: { id: u.ingredientId } });
        if (!ing) continue;
        const stock = ing.stock || {};
        stock[u.location] = { amount: parseFloat(u.amount) || 0, date: new Date().toISOString().slice(0, 10) };
        await tx.ingredient.update({ where: { id: u.ingredientId }, data: { stock } });
      }
    });
    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'stock-update', `bulk stock update: ${updates.length} items`);
    res.json({ ok: true, updated: updates.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save single ingredient (create or update) — must be after specific routes
router.post('/:id', async (req, res) => {
  const ingredient = req.body;
  if (!ingredient || !ingredient.name) return res.status(400).json({ error: 'name required' });
  try {
    const data = {
      name: ingredient.name || '',
      supplierName: ingredient.supplierName || '',
      types: ingredient.types || [],
      category: ingredient.category || '',
      unit: ingredient.unit || 'Grams',
      supplier: ingredient.supplier || '',
      orderCode: ingredient.orderCode || '',
      orderUnit: ingredient.orderUnit || '',
      orderUnitStandard: ingredient.orderUnitStandard || '',
      orderPrice: ingredient.orderPrice != null ? parseFloat(ingredient.orderPrice) || null : null,
      orderAmountGrams: parseFloat(ingredient.orderAmountGrams) || 0,
      priceLevel: ingredient.priceLevel || '',
      pricePer100g: parseFloat(ingredient.pricePer100g) || 0,
      priceHistory: ingredient.priceHistory || [],
      priceAlert: !!ingredient.priceAlert,
      storageLocations: ingredient.storageLocations || {},
      stock: ingredient.stock || {},
      nutrition: ingredient.nutrition || {},
      allergens: ingredient.allergens || '',
      notes: ingredient.notes || '',
      active: ingredient.active !== false,
    };
    await prisma.ingredient.upsert({
      where: { id: req.params.id },
      create: { id: req.params.id, ...data },
      update: data,
    });
    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'ingredient', `saved "${ingredient.name}"`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete ingredient
router.delete('/:id', async (req, res) => {
  try {
    await prisma.ingredient.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.loadIngredients = loadIngredients;
