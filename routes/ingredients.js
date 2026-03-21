const router = require('express').Router();
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { CONFIG, INGREDIENTS_SEED } = require('../lib/config');
const { getSheetsClient, readTab, writeTab, ensureTabsExist, withWriteLock, dbAppendLog, INGREDIENT_HEADERS, rowToIngredient, ingredientToRow, parseHanosQuantityGrams } = require('../lib/sheets');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Helper: load ingredients from Sheets or fall back to seed file
async function loadIngredients() {
  const sheets = getSheetsClient();
  if (sheets && CONFIG.DB_SHEET_ID) {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['ingredients']);
    const rows = await readTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients');
    if (rows.length > 0) return rows.map(rowToIngredient);
  }
  // Fallback: load from seed file (dev mode or before first Sheets write)
  if (fs.existsSync(INGREDIENTS_SEED)) {
    return JSON.parse(fs.readFileSync(INGREDIENTS_SEED, 'utf8'));
  }
  return [];
}

router.get('/', async (req, res) => {
  try {
    const ingredients = await loadIngredients();
    // Map to format expected by frontend (backward-compatible with old ingredient DB)
    res.json(ingredients.map(ing => ({
      id: ing.id,
      name: ing.name,
      supplierName: ing.supplierName,
      category: ing.category,
      unit: ing.unit,
      source: ing.supplier,
      orderCode: ing.orderCode,
      orderUnit: ing.orderUnit,
      orderUnitStandard: ing.orderUnitStandard,
      orderPrice: ing.orderPrice || '',
      orderAmount: ing.orderAmountGrams,
      unitRecalc: ing.orderAmountGrams,
      allergens: ing.allergens,
      notes: ing.notes,
      storageLocation: ing.storageLocation,
      active: ing.active,
    })));
  } catch (e) {
    console.error('Ingredient DB error:', e.message);
    res.json({ error: e.message, items: [] });
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
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['ingredients']);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients', INGREDIENT_HEADERS, ingredients.map(ingredientToRow));
    });
    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'ingredients-bulk', `saved ${ingredients.length} ingredients`);
    res.json({ ok: true, count: ingredients.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload and parse Hanos XLSX — returns parsed products for review
// NOTE: specific routes like /upload-supplier and /migrate MUST come before /:id
router.post('/upload-supplier', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets['prices'] || wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (data.length < 2) return res.json([]);
    const headers = data[0];

    const col = (name) => headers.indexOf(name);
    const titleIdx = col('title');
    const codeIdx = col('artikelnummer');
    const priceIdx = col('stukprijs');
    const qtyIdx = col('hoeveelheid');
    const stdQtyIdx = col('hoeveelheid_standaard');
    const catIdx = col('categorie');
    const subCatIdx = col('subcategorie');

    // Find month columns for recent order detection
    const monthCols = headers.map((h, i) => ({ name: h, idx: i }))
      .filter(c => /^[A-Z][a-z]{2}-\d{2}$/.test(c.name));
    const last6 = monthCols.slice(-6);

    const products = data.slice(1).filter(r => r[titleIdx]).map(r => {
      const recentOrders = last6.reduce((sum, mc) => sum + (parseFloat(r[mc.idx]) || 0), 0);
      return {
        title: r[titleIdx] || '',
        orderCode: String(r[codeIdx] || ''),
        price: r[priceIdx] != null ? parseFloat(r[priceIdx]) : null,
        orderUnit: r[qtyIdx] || '',
        orderUnitStandard: r[stdQtyIdx] || '',
        category: r[catIdx] || '',
        subcategory: r[subCatIdx] || '',
        orderAmountGrams: parseHanosQuantityGrams(r[qtyIdx] || ''),
        recentOrders: Math.round(recentOrders * 10) / 10,
      };
    });

    res.json(products);
  } catch (e) {
    console.error('XLSX parse error:', e.message);
    res.status(500).json({ error: 'Failed to parse file: ' + e.message });
  }
});

// One-time migration: merge old CSV ingredient DB + Hanos XLSX
router.post('/migrate', upload.fields([
  { name: 'oldCsv', maxCount: 1 },
  { name: 'hanosXlsx', maxCount: 1 },
]), async (req, res) => {
  try {
    const sheets = getSheetsClient();
    if (!sheets || !CONFIG.DB_SHEET_ID) return res.status(503).json({ error: 'Sheets not configured' });

    // Parse old CSV
    const oldIngredients = [];
    if (req.files.oldCsv && req.files.oldCsv[0]) {
      const csvText = req.files.oldCsv[0].buffer.toString('utf8');
      const lines = csvText.split('\n');
      lines.slice(3).forEach(line => {
        const cols = line.split(',');
        const name = (cols[1] || '').trim();
        if (!name || name === 'Name') return;
        oldIngredients.push({
          category: (cols[0] || '').trim(),
          name,
          unit: (cols[2] || 'Grams').trim(),
          source: (cols[3] || '').trim(),
          orderCode: (cols[6] || '').trim(),
          notes: (cols[23] || '').trim(),
          storageLocation: (cols[15] || '').trim(),
          allergens: (cols[14] || '').trim(),
        });
      });
    }

    // Parse Hanos XLSX
    const hanosByCode = {};
    if (req.files.hanosXlsx && req.files.hanosXlsx[0]) {
      const wb = XLSX.read(req.files.hanosXlsx[0].buffer, { type: 'buffer' });
      const ws = wb.Sheets['prices'] || wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      data.slice(1).forEach(r => {
        const code = String(r[1] || '');
        if (code) {
          hanosByCode[code] = {
            title: r[0] || '',
            price: r[3] != null ? parseFloat(r[3]) : null,
            orderUnit: r[4] || '',
            orderUnitStandard: r[5] || '',
            category: r[18] || '',
            orderAmountGrams: parseHanosQuantityGrams(r[4] || ''),
          };
        }
      });
    }

    // Merge: old ingredients enriched with Hanos data
    const merged = [];
    const usedCodes = new Set();

    oldIngredients.forEach(old => {
      const id = crypto.randomUUID();
      const code = old.orderCode.replace(/[^0-9]/g, '');
      const hanos = code ? hanosByCode[code] : null;

      merged.push({
        id,
        name: old.name,
        supplierName: hanos ? hanos.title : '',
        category: old.category || '',
        unit: old.unit || 'Grams',
        supplier: old.source || (hanos ? 'Hanos' : ''),
        orderCode: code || '',
        orderUnit: hanos ? hanos.orderUnit : '',
        orderUnitStandard: hanos ? hanos.orderUnitStandard : '',
        orderPrice: hanos ? hanos.price : null,
        orderAmountGrams: hanos ? hanos.orderAmountGrams : 0,
        allergens: old.allergens || '',
        notes: old.notes || '',
        storageLocation: old.storageLocation || '',
        active: true,
      });

      if (code) usedCodes.add(code);
    });

    // Write to Google Sheets
    await withWriteLock(async () => {
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['ingredients']);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients', INGREDIENT_HEADERS, merged.map(ingredientToRow));
    });

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'ingredient-migration',
      `Migrated ${merged.length} ingredients (${Object.keys(hanosByCode).length} Hanos products available, ${usedCodes.size} matched)`);

    res.json({
      ok: true,
      total: merged.length,
      hanosMatched: usedCodes.size,
      hanosAvailable: Object.keys(hanosByCode).length,
    });
  } catch (e) {
    console.error('Migration error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Save single ingredient (create or update) — must be after specific routes
router.post('/:id', async (req, res) => {
  const ingredient = req.body;
  if (!ingredient || !ingredient.name) return res.status(400).json({ error: 'name required' });
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['ingredients']);
      const existing = await readTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients');
      const all = existing.map(rowToIngredient);
      const idx = all.findIndex(i => i.id === req.params.id);
      if (idx >= 0) {
        all[idx] = { ...all[idx], ...ingredient, id: req.params.id };
      } else {
        all.push({ ...ingredient, id: req.params.id });
      }
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients', INGREDIENT_HEADERS, all.map(ingredientToRow));
    });
    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'ingredient', `saved "${ingredient.name}"`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete ingredient
router.delete('/:id', async (req, res) => {
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      const existing = await readTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients');
      const all = existing.map(rowToIngredient).filter(i => i.id !== req.params.id);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'ingredients', INGREDIENT_HEADERS, all.map(ingredientToRow));
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.loadIngredients = loadIngredients;
