const router = require('express').Router();
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { prisma, dbAppendLog } = require('../lib/db');
const { parseHanosQuantityGrams } = require('../lib/hanos-parser');
const { mapHanosCategory } = require('../lib/hanos-categories');
const { parseCsv } = require('../lib/csv-parser');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Shared helpers for XLSX and CSV parsing ──

const NUTRITION_KEYS = {
  'Energie (kJ)': 'energyKj', 'Energie (Kcal)': 'energyKcal',
  'Eiwitten (gram)': 'protein', 'Koolhydraten (gram)': 'carbs',
  '- waarvan suiker (gram)': 'sugar', 'Vet (gram)': 'fat',
  '- waarvan verzadigd (gram)': 'saturatedFat',
  'Vezels (gram)': 'fiber', 'Zout (gram)': 'salt',
};

/** Extract nutrition values from a row using column index map */
function parseNutrition(row, nutColMap) {
  const nutrition = {};
  for (const [key, idx] of Object.entries(nutColMap)) {
    if (idx >= 0 && row[idx] != null && row[idx] !== '') {
      const v = parseFloat(row[idx]);
      if (!isNaN(v)) nutrition[key] = v;
    }
  }
  return Object.keys(nutrition).length ? nutrition : null;
}

/** Build nutrition column index map from headers */
function buildNutritionColMap(headers) {
  const map = {};
  for (const [headerName, key] of Object.entries(NUTRITION_KEYS)) {
    map[key] = headers.indexOf(headerName);
  }
  return map;
}

/** Extract price history from month columns in a row */
function parsePriceHistory(row, monthCols) {
  const history = [];
  monthCols.forEach(mc => {
    const raw = row[mc.idx];
    if (raw == null || raw === '' || raw === 0 || raw === '0') return;
    const cleaned = typeof raw === 'string' ? raw.replace(/[€\s]/g, '').replace(',', '.') : String(raw);
    const val = parseFloat(cleaned);
    if (!isNaN(val) && val > 0) history.push({ month: mc.name.trim(), price: Math.round(val * 100) / 100 });
  });
  return history;
}

/** Find month columns (pattern "Jan-24", "Feb-25", etc.) from header array */
function findMonthCols(headers) {
  return headers.map((h, i) => ({ name: String(h || '').trim(), idx: i }))
    .filter(c => /^[A-Z][a-z]{2}-\d{2}$/.test(c.name));
}

// ── Upload and parse Hanos XLSX — returns parsed products for review ──

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

    const monthCols = findMonthCols(headers);
    const last6 = monthCols.slice(-6);
    const nutColMap = buildNutritionColMap(headers);

    const products = data.slice(1).filter(r => r[titleIdx]).map(r => {
      const recentOrders = last6.reduce((sum, mc) => sum + (parseFloat(r[mc.idx]) || 0), 0);
      return {
        title: r[titleIdx] || '',
        orderCode: String(r[codeIdx] || ''),
        price: r[priceIdx] != null ? parseFloat(r[priceIdx]) : null,
        orderUnit: r[qtyIdx] || '',
        orderUnitStandard: r[stdQtyIdx] || '',
        category: r[catIdx] || '',
        subcategory: r[col('subcategorie')] || '',
        orderAmountGrams: parseHanosQuantityGrams(r[qtyIdx] || ''),
        recentOrders: Math.round(recentOrders * 10) / 10,
        priceHistory: parsePriceHistory(r, monthCols),
        nutrition: parseNutrition(r, nutColMap),
      };
    });

    res.json(products);
  } catch (e) {
    console.error('XLSX parse error:', e.message);
    res.status(500).json({ error: 'Failed to parse file: ' + e.message });
  }
});

// ── Migration: merge old CSV ingredient DB + Hanos CSV ──

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
        const code = (cols[6] || '').trim().replace(/[^0-9]/g, '');
        if (code) {
          oldByCode[code] = {
            name, category: (cols[0] || '').trim(), unit: (cols[2] || 'Grams').trim(),
            source: (cols[3] || '').trim(), notes: (cols[23] || '').trim(),
            storageLocation: (cols[15] || '').trim(), allergens: (cols[14] || '').trim(),
          };
        }
      });
    }

    // Parse Hanos CSV
    const merged = [];
    let matchedCount = 0, hanosOnlyCount = 0;

    if (req.files.hanosCsv && req.files.hanosCsv[0]) {
      const csvText = req.files.hanosCsv[0].buffer.toString('utf8');
      const { headers, rows } = parseCsv(csvText);
      if (headers.length === 0) return res.json({ error: 'Empty Hanos file' });

      const col = (name) => headers.indexOf(name);
      const titleIdx = col('title');
      const codeIdx = col('artikelnummer');
      const priceIdx = col('stukprijs');
      const qtyIdx = col('hoeveelheid');
      const stdQtyIdx = col('hoeveelheid_standaard');
      const catIdx = col('categorie');

      const monthCols = findMonthCols(headers);
      const last12 = monthCols.slice(-12);
      const nutColMap = buildNutritionColMap(headers);

      for (const r of rows) {
        const title = r[titleIdx] || '';
        const code = String(r[codeIdx] || '').trim();
        if (!title || !code) continue;

        const price = r[priceIdx] != null ? parseFloat(r[priceIdx]) : null;
        const mapped = mapHanosCategory(r[catIdx] || '');
        const orderAmountGrams = parseHanosQuantityGrams(r[qtyIdx] || '');

        const recentOrders = last12.reduce((sum, mc) => {
          const raw = r[mc.idx];
          if (!raw) return sum;
          const val = parseFloat(String(raw).replace(/[€\s]/g, '').replace(',', '.'));
          return sum + (isNaN(val) ? 0 : (val > 0 ? 1 : 0));
        }, 0);

        const old = oldByCode[code];
        if (old) matchedCount++; else hanosOnlyCount++;

        const pricePer100g = (price && orderAmountGrams > 0)
          ? Math.round((price / orderAmountGrams) * 10000) / 100 : 0;

        merged.push({
          id: crypto.randomUUID(),
          name: old ? old.name : title,
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
          priceHistory: parsePriceHistory(r, monthCols),
          priceAlert: false,
          storageLocations: old && old.storageLocation ? { west: old.storageLocation } : {},
          stock: {},
          nutrition: parseNutrition(r, nutColMap) || {},
          allergens: old ? old.allergens : '',
          notes: old ? old.notes : '',
          active: recentOrders > 0,
        });
      }
    }

    const stats = {
      total: merged.length, matched: matchedCount, hanosOnly: hanosOnlyCount,
      active: merged.filter(i => i.active).length, inactive: merged.filter(i => !i.active).length,
      oldDbSize: Object.keys(oldByCode).length, dryRun,
    };

    if (dryRun) {
      return res.json({ ...stats, sample: merged.slice(0, 20).map(i => ({
        name: i.name, supplierName: i.supplierName, types: i.types,
        category: i.category, active: i.active, orderCode: i.orderCode,
      })) });
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

module.exports = router;
