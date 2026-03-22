const router = require('express').Router();
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { INGREDIENTS_SEED } = require('../lib/config');
const { prisma, dbAppendLog } = require('../lib/db');
const { parseHanosQuantityGrams } = require('../lib/sheets');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Helper: load ingredients from Postgres or fall back to seed file
async function loadIngredients() {
  try {
    const rows = await prisma.ingredient.findMany();
    if (rows.length > 0) return rows;
  } catch (e) {
    console.error('DB ingredient load error:', e.message);
  }
  // Fallback: load from seed file (dev mode or before first DB write)
  if (fs.existsSync(INGREDIENTS_SEED)) {
    return JSON.parse(fs.readFileSync(INGREDIENTS_SEED, 'utf8'));
  }
  return [];
}

router.get('/', async (req, res) => {
  try {
    const ingredients = await loadIngredients();
    // Map to format expected by frontend
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

// Upload and parse Hanos XLSX — returns parsed products for review
// NOTE: specific routes like /upload-supplier, /migrate, /stock MUST come before /:id
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

    // Nutrition column indices
    const nutIdx = {
      energyKj: col('Energie (kJ)'), energyKcal: col('Energie (Kcal)'),
      protein: col('Eiwitten (gram)'), carbs: col('Koolhydraten (gram)'),
      sugar: col('- waarvan suiker (gram)'), fat: col('Vet (gram)'),
      saturatedFat: col('- waarvan verzadigd (gram)'),
      fiber: col('Vezels (gram)'), salt: col('Zout (gram)'),
    };

    const products = data.slice(1).filter(r => r[titleIdx]).map(r => {
      const recentOrders = last6.reduce((sum, mc) => sum + (parseFloat(r[mc.idx]) || 0), 0);
      // Build price history from month columns
      const priceHistory = [];
      monthCols.forEach(mc => {
        const raw = r[mc.idx];
        if (raw == null || raw === '' || raw === 0) return;
        const val = typeof raw === 'string' ? parseFloat(raw.replace(/[€\s,]/g, '').replace(',', '.')) : parseFloat(raw);
        if (!isNaN(val) && val > 0) priceHistory.push({ month: mc.name.trim(), price: Math.round(val * 100) / 100 });
      });
      // Build nutrition object
      const nutrition = {};
      Object.entries(nutIdx).forEach(([key, idx]) => {
        if (idx >= 0 && r[idx] != null && r[idx] !== '') nutrition[key] = parseFloat(r[idx]) || 0;
      });

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
        priceHistory,
        nutrition: Object.keys(nutrition).length ? nutrition : null,
      };
    });

    res.json(products);
  } catch (e) {
    console.error('XLSX parse error:', e.message);
    res.status(500).json({ error: 'Failed to parse file: ' + e.message });
  }
});

// Hanos category → app type + category mapping
const HANOS_TYPE_MAP = {
  'Aardappelen en aardappelproducten': { types: ['Food'], category: 'Grains & Starches' },
  'Antipasti en Olijven': { types: ['Food'], category: 'Canned & Preserved' },
  'Bak- en dessertprodukten': { types: ['Food'], category: 'Baking & Dessert' },
  'Brood': { types: ['Food'], category: 'Grains & Starches' },
  'Brood en banket': { types: ['Food'], category: 'Grains & Starches' },
  'Champignons en paddenstoelen': { types: ['Food'], category: 'Vegetables & Fruit' },
  'Chocolade': { types: ['Food'], category: 'Baking & Dessert' },
  'Chocolade en suikerwerk': { types: ['Food'], category: 'Baking & Dessert' },
  'Conserven': { types: ['Food'], category: 'Canned & Preserved' },
  'Fruit': { types: ['Food'], category: 'Vegetables & Fruit' },
  'Groente en fruit': { types: ['Food'], category: 'Vegetables & Fruit' },
  'Groenten': { types: ['Food'], category: 'Vegetables & Fruit' },
  'Grondstoffen en ingrediënten': { types: ['Food'], category: 'Sauces & Condiments' },
  'IJs- en handijs': { types: ['Food'], category: 'Baking & Dessert' },
  'Internationale keuken': { types: ['Food'], category: 'Sauces & Condiments' },
  'Kaas': { types: ['Food'], category: 'Dairy & Alternatives' },
  'Kruiden': { types: ['Food'], category: 'Herbs & Spices' },
  'Kruiden en specerijen': { types: ['Food'], category: 'Herbs & Spices' },
  'Maaltijdversierders': { types: ['Food'], category: 'Herbs & Spices' },
  'Overige diepvriesproducten': { types: ['Food'], category: 'Canned & Preserved' },
  'Rijst en Deegwaren': { types: ['Food'], category: 'Grains & Starches' },
  'Sauzen': { types: ['Food'], category: 'Sauces & Condiments' },
  'Snacks': { types: ['Food'], category: 'Snacks' },
  'Suiker': { types: ['Food'], category: 'Baking & Dessert' },
  "Tapenades en pesto's": { types: ['Food'], category: 'Sauces & Condiments' },
  'Texturas': { types: ['Food'], category: 'Herbs & Spices' },
  'Vetten en olie': { types: ['Food'], category: 'Oils & Fats' },
  'Zeewier en zeewierproducten': { types: ['Food'], category: 'Seaweed & Specialty' },
  'Zuivel': { types: ['Food'], category: 'Dairy & Alternatives' },
  'Zuren en azijn': { types: ['Food'], category: 'Sauces & Condiments' },
  'Bieren': { types: ['Drinks'], category: 'Beer' },
  'Gedistilleerd': { types: ['Drinks'], category: 'Spirits & Liqueurs' },
  'Koude dranken': { types: ['Drinks'], category: 'Juices & Soft Drinks' },
  'Warme dranken': { types: ['Drinks'], category: 'Coffee & Tea' },
  'Wijn': { types: ['Drinks'], category: 'Wine' },
  'Aan Tafel': { types: ['FOH Supplies'], category: 'Tableware & FOH' },
  'Bar en buffet': { types: ['FOH Equipment'], category: 'Tableware & FOH' },
  'Barbecues en benodigdheden': { types: ['Kitchen Equipment'], category: 'Kitchen Equipment' },
  'Disposables': { types: ['FOH Supplies'], category: 'Disposables & Packaging' },
  'Kantoor en administratie': { types: ['Office'], category: 'Office & Admin' },
  'Keuken': { types: ['Kitchen Equipment'], category: 'Kitchen Equipment' },
  'Keukenapparatuur': { types: ['Kitchen Equipment'], category: 'Kitchen Equipment' },
  'Kleding en textiel': { types: ['Kitchen Equipment'], category: 'Clothing & Textiles' },
  'Persoonlijke verzorging': { types: ['Cleaning'], category: 'Cleaning & Hygiene' },
  'Schoonmaak en hygiëne': { types: ['Cleaning'], category: 'Cleaning & Hygiene' },
  'Veiligheid': { types: ['Kitchen Equipment'], category: 'Kitchen Equipment' },
};

function mapHanosCategory(hanosCat) {
  return HANOS_TYPE_MAP[hanosCat] || { types: ['Food'], category: '' };
}

// Migration: merge old CSV ingredient DB + Hanos CSV, new schema
router.post('/migrate', upload.fields([
  { name: 'oldCsv', maxCount: 1 },
  { name: 'hanosCsv', maxCount: 1 },
]), async (req, res) => {
  try {
    const dryRun = req.query.dryRun === 'true';

    // Parse old CSV — extract names and order codes for matching
    const oldByCode = {};
    if (req.files.oldCsv && req.files.oldCsv[0]) {
      const csvText = req.files.oldCsv[0].buffer.toString('utf8');
      const lines = csvText.split('\n');
      lines.slice(3).forEach(line => {
        const cols = line.split(',');
        const name = (cols[1] || '').trim();
        if (!name || name === 'Name') return;
        const rawCode = (cols[6] || '').trim();
        const code = rawCode.replace(/[^0-9]/g, '');
        if (code) {
          oldByCode[code] = {
            name,
            category: (cols[0] || '').trim(),
            unit: (cols[2] || 'Grams').trim(),
            source: (cols[3] || '').trim(),
            notes: (cols[23] || '').trim(),
            storageLocation: (cols[15] || '').trim(),
            allergens: (cols[14] || '').trim(),
          };
        }
      });
    }

    // Parse Hanos CSV
    const merged = [];
    let matchedCount = 0;
    let hanosOnlyCount = 0;
    if (req.files.hanosCsv && req.files.hanosCsv[0]) {
      const csvText = req.files.hanosCsv[0].buffer.toString('utf8');
      const lines = csvText.split('\n');
      if (lines.length < 2) return res.json({ error: 'Empty Hanos file' });

      const headerLine = lines[0];
      const headers = [];
      let inQuote = false, field = '';
      for (let i = 0; i < headerLine.length; i++) {
        const ch = headerLine[i];
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === ',' && !inQuote) { headers.push(field.trim()); field = ''; }
        else { field += ch; }
      }
      headers.push(field.trim());

      const col = (name) => headers.indexOf(name);
      const titleIdx = col('title');
      const codeIdx = col('artikelnummer');
      const priceIdx = col('stukprijs');
      const qtyIdx = col('hoeveelheid');
      const stdQtyIdx = col('hoeveelheid_standaard');
      const catIdx = col('categorie');

      const nutCols = {
        energyKj: col('Energie (kJ)'), energyKcal: col('Energie (Kcal)'),
        protein: col('Eiwitten (gram)'), carbs: col('Koolhydraten (gram)'),
        sugar: col('- waarvan suiker (gram)'), fat: col('Vet (gram)'),
        saturatedFat: col('- waarvan verzadigd (gram)'),
        fiber: col('Vezels (gram)'), salt: col('Zout (gram)'),
      };

      const monthCols = headers.map((h, i) => ({ name: h.trim(), idx: i }))
        .filter(c => /^[A-Z][a-z]{2}-\d{2}$/.test(c.name));
      const last12 = monthCols.slice(-12);

      for (let li = 1; li < lines.length; li++) {
        if (!lines[li].trim()) continue;
        const r = [];
        let inQ = false, f = '';
        for (let i = 0; i < lines[li].length; i++) {
          const ch = lines[li][i];
          if (ch === '"') { inQ = !inQ; }
          else if (ch === ',' && !inQ) { r.push(f.trim()); f = ''; }
          else { f += ch; }
        }
        r.push(f.trim());

        const title = r[titleIdx] || '';
        const code = String(r[codeIdx] || '').trim();
        if (!title || !code) continue;

        const price = r[priceIdx] != null ? parseFloat(r[priceIdx]) : null;
        const hanosCat = r[catIdx] || '';
        const mapped = mapHanosCategory(hanosCat);
        const orderAmountGrams = parseHanosQuantityGrams(r[qtyIdx] || '');

        const priceHistory = [];
        monthCols.forEach(mc => {
          const raw = r[mc.idx];
          if (!raw || raw === '' || raw === '0') return;
          const cleaned = raw.replace(/[€\s]/g, '').replace(',', '.');
          const val = parseFloat(cleaned);
          if (!isNaN(val) && val > 0) priceHistory.push({ month: mc.name, price: Math.round(val * 100) / 100 });
        });

        const recentOrders = last12.reduce((sum, mc) => {
          const raw = r[mc.idx];
          if (!raw) return sum;
          const val = parseFloat(raw.replace(/[€\s]/g, '').replace(',', '.'));
          return sum + (isNaN(val) ? 0 : (val > 0 ? 1 : 0));
        }, 0);

        const nutrition = {};
        Object.entries(nutCols).forEach(([key, idx]) => {
          if (idx >= 0 && r[idx] != null && r[idx] !== '') {
            const v = parseFloat(r[idx]);
            if (!isNaN(v)) nutrition[key] = v;
          }
        });

        const old = oldByCode[code];
        const name = old ? old.name : title;
        if (old) matchedCount++;
        else hanosOnlyCount++;

        const pricePer100g = (price && orderAmountGrams > 0)
          ? Math.round((price / orderAmountGrams) * 10000) / 100
          : 0;

        merged.push({
          id: crypto.randomUUID(),
          name,
          supplierName: title,
          types: mapped.types,
          category: mapped.category,
          unit: old ? old.unit : 'Grams',
          supplier: 'Hanos',
          orderCode: code,
          orderUnit: r[qtyIdx] || '',
          orderUnitStandard: r[stdQtyIdx] || '',
          orderPrice: price,
          orderAmountGrams,
          priceLevel: '',
          pricePer100g,
          priceHistory,
          priceAlert: false,
          storageLocations: old && old.storageLocation ? { west: old.storageLocation } : {},
          stock: {},
          nutrition: Object.keys(nutrition).length ? nutrition : {},
          allergens: old ? old.allergens : '',
          notes: old ? old.notes : '',
          active: recentOrders > 0,
        });
      }
    }

    const stats = {
      total: merged.length,
      matched: matchedCount,
      hanosOnly: hanosOnlyCount,
      active: merged.filter(i => i.active).length,
      inactive: merged.filter(i => !i.active).length,
      oldDbSize: Object.keys(oldByCode).length,
      dryRun,
    };

    if (dryRun) {
      return res.json({ ...stats, sample: merged.slice(0, 20).map(i => ({ name: i.name, supplierName: i.supplierName, types: i.types, category: i.category, active: i.active, orderCode: i.orderCode })) });
    }

    await prisma.$transaction([
      prisma.ingredient.deleteMany(),
      prisma.ingredient.createMany({ data: merged }),
    ]);

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'ingredient-migration',
      `Migrated ${merged.length} ingredients (${matchedCount} matched with old DB, ${hanosOnlyCount} Hanos-only)`);

    res.json({ ok: true, ...stats });
  } catch (e) {
    console.error('Migration error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update stock for a single ingredient at one location
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
