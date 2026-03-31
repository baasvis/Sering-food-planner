import express, { Request, Response } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import XLSX from 'xlsx';
import { prisma, dbAppendLog } from '../lib/db';
import { errMsg } from '../lib/config';
import { parseHanosQuantityGrams } from '../lib/hanos-parser';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Hanos category → app type + category mapping
const HANOS_TYPE_MAP: Record<string, { types: string[]; category: string }> = {
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

function mapHanosCategory(hanosCat: string) {
  return HANOS_TYPE_MAP[hanosCat] || { types: ['Food'], category: '' };
}

// Upload and parse Hanos XLSX — returns parsed products for review
router.post('/upload-supplier', upload.single('file'), (req: Request, res: Response) => {
  const file = (req as any).file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(file.buffer, { type: 'buffer' });
    const ws = wb.Sheets['prices'] || wb.Sheets[wb.SheetNames[0]];
    const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (data.length < 2) return res.json([]);
    const headers = data[0] as string[];

    const col = (name: string) => headers.indexOf(name);
    const titleIdx = col('title');
    const codeIdx = col('artikelnummer');
    const priceIdx = col('stukprijs');
    const qtyIdx = col('hoeveelheid');
    const catIdx = col('categorie');

    // Find month columns for recent order detection
    const monthCols = headers.map((h, i) => ({ name: h, idx: i }))
      .filter(c => /^[A-Z][a-z]{2}-\d{2}$/.test(c.name));
    const last6 = monthCols.slice(-6);

    // Nutrition column indices
    const nutIdx: Record<string, number> = {
      energyKj: col('Energie (kJ)'), energyKcal: col('Energie (Kcal)'),
      protein: col('Eiwitten (gram)'), carbs: col('Koolhydraten (gram)'),
      sugar: col('- waarvan suiker (gram)'), fat: col('Vet (gram)'),
      saturatedFat: col('- waarvan verzadigd (gram)'),
      fiber: col('Vezels (gram)'), salt: col('Zout (gram)'),
    };

    const products = data.slice(1).filter(r => r[titleIdx]).map(r => {
      const recentOrders = last6.reduce((sum, mc) => sum + (parseFloat(r[mc.idx]) || 0), 0);
      const priceHistory: Array<{ month: string; price: number }> = [];
      monthCols.forEach(mc => {
        const raw = r[mc.idx];
        if (raw == null || raw === '' || raw === 0) return;
        const val = typeof raw === 'string' ? parseFloat(raw.replace(/[€\s,]/g, '').replace(',', '.')) : parseFloat(raw);
        if (!isNaN(val) && val > 0) priceHistory.push({ month: mc.name.trim(), price: Math.round(val * 100) / 100 });
      });
      const nutrition: Record<string, number> = {};
      Object.entries(nutIdx).forEach(([key, idx]) => {
        if (idx >= 0 && r[idx] != null && r[idx] !== '') nutrition[key] = parseFloat(r[idx]) || 0;
      });

      return {
        title: r[titleIdx] || '',
        orderCode: String(r[codeIdx] || ''),
        price: r[priceIdx] != null ? parseFloat(r[priceIdx]) : null,
        orderUnit: r[qtyIdx] || '',
        category: r[catIdx] || '',
        orderUnitSize: parseHanosQuantityGrams(r[qtyIdx] || ''),
        recentOrders: Math.round(recentOrders * 10) / 10,
        priceHistory,
        nutrition: Object.keys(nutrition).length ? nutrition : null,
      };
    });

    res.json(products);
  } catch (e: unknown) {
    console.error('XLSX parse error:', errMsg(e));
    res.status(500).json({ error: 'Failed to parse file: ' + errMsg(e) });
  }
});

// Migration: merge old CSV ingredient DB + Hanos CSV, new schema
router.post('/migrate', upload.fields([
  { name: 'oldCsv', maxCount: 1 },
  { name: 'hanosCsv', maxCount: 1 },
]), async (req: Request, res: Response) => {
  try {
    const dryRun = req.query.dryRun === 'true';
    const files = (req as any).files as { [fieldname: string]: { buffer: Buffer }[] };

    // Parse old CSV
    const oldByCode: Record<string, any> = {};
    if (files.oldCsv && files.oldCsv[0]) {
      const csvText = files.oldCsv[0].buffer.toString('utf8');
      const lines = csvText.split('\n');
      lines.slice(3).forEach((line: string) => {
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
    const merged: any[] = [];
    let matchedCount = 0;
    let hanosOnlyCount = 0;
    if (files.hanosCsv && files.hanosCsv[0]) {
      const csvText = files.hanosCsv[0].buffer.toString('utf8');
      const lines = csvText.split('\n');
      if (lines.length < 2) return res.json({ error: 'Empty Hanos file' });

      const headerLine = lines[0];
      const headers: string[] = [];
      let inQuote = false, field = '';
      for (let i = 0; i < headerLine.length; i++) {
        const ch = headerLine[i];
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === ',' && !inQuote) { headers.push(field.trim()); field = ''; }
        else { field += ch; }
      }
      headers.push(field.trim());

      const col = (name: string) => headers.indexOf(name);
      const titleIdx = col('title');
      const codeIdx = col('artikelnummer');
      const priceIdx = col('stukprijs');
      const qtyIdx = col('hoeveelheid');
      const catIdx = col('categorie');

      const nutCols: Record<string, number> = {
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
        const r: string[] = [];
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
        const orderUnitSize = parseHanosQuantityGrams(r[qtyIdx] || '');

        const priceHistory: Array<{ month: string; price: number }> = [];
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

        const nutrition: Record<string, number> = {};
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

        const pricePer100 = (price && orderUnitSize > 0)
          ? Math.round((price / orderUnitSize) * 10000) / 100
          : 0;

        merged.push({
          id: crypto.randomUUID(),
          name,
          supplierName: title,
          types: mapped.types,
          category: mapped.category,
          measureMode: 'weight',
          unit: old ? old.unit : 'Grams',
          supplier: 'Hanos',
          orderCode: code,
          orderUnit: r[qtyIdx] || '',
          orderPrice: price,
          orderUnitSize,
          priceLevel: '',
          pricePer100,
          priceHistory,
          priceAlert: false,
          storageLocations: old && old.storageLocation ? { west: old.storageLocation } : {},
          stock: {},
          targetStock: {},
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
      active: merged.filter((i: any) => i.active).length,
      inactive: merged.filter((i: any) => !i.active).length,
      oldDbSize: Object.keys(oldByCode).length,
      dryRun,
    };

    if (dryRun) {
      return res.json({ ...stats, sample: merged.slice(0, 20).map((i: any) => ({ name: i.name, supplierName: i.supplierName, types: i.types, category: i.category, active: i.active, orderCode: i.orderCode })) });
    }

    await prisma.$transaction([
      prisma.ingredient.deleteMany(),
      prisma.ingredient.createMany({ data: merged }),
    ]);

    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'ingredient-migration',
      `Migrated ${merged.length} ingredients (${matchedCount} matched with old DB, ${hanosOnlyCount} Hanos-only)`);

    res.json({ ok: true, ...stats });
  } catch (e: unknown) {
    console.error('Migration error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

export default router;
