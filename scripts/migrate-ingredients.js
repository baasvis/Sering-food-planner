#!/usr/bin/env node
// One-time migration: merge old ingredient CSV + Hanos XLSX → ingredients tab in main Google Sheet
// Usage: node scripts/migrate-ingredients.js <old-csv-path> <hanos-xlsx-path>
//
// Requires: DB_SHEET_ID and GOOGLE_CREDENTIALS environment variables set
// (or a .env file in the project root)

try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const XLSX = require('xlsx');

const DB_SHEET_ID = process.env.DB_SHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS || '{}';

if (!DB_SHEET_ID) { console.error('DB_SHEET_ID not set'); process.exit(1); }

const INGREDIENT_HEADERS = [
  'id','name','supplier_name','category','unit','supplier',
  'order_code','order_unit','order_unit_standard','order_price',
  'order_amount_grams','allergens','notes','storage_location','active'
];

function parseHanosQuantityGrams(hoeveelheid) {
  if (!hoeveelheid) return 0;
  const s = hoeveelheid.toLowerCase();
  const numMatch = s.match(/([\d.,]+)\s*(kilo(?:gram)?|gram|liter|ml|stuk)/);
  if (!numMatch) return 0;
  const num = parseFloat(numMatch[1].replace(',', '.'));
  const unit = numMatch[2];
  if (unit.startsWith('kilo')) return num * 1000;
  if (unit === 'liter') return num * 1000;
  if (unit === 'gram') return num;
  if (unit === 'ml') return num;
  return 0;
}

async function main() {
  const csvPath = process.argv[2] || path.join(__dirname, '..', 'data', 'old-ingredients.csv');
  const xlsxPath = process.argv[3] || path.join(__dirname, '..', 'data', 'hanos.xlsx');

  if (!fs.existsSync(csvPath)) { console.error('CSV not found:', csvPath); process.exit(1); }
  if (!fs.existsSync(xlsxPath)) { console.error('XLSX not found:', xlsxPath); process.exit(1); }

  console.log('Reading old ingredient CSV...');
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const lines = csvText.split('\n');
  const oldIngredients = [];
  lines.slice(3).forEach(line => {
    const cols = line.split(',');
    const name = (cols[1] || '').trim();
    if (!name || name === 'Name') return;
    oldIngredients.push({
      category: (cols[0] || '').trim(),
      name,
      unit: (cols[2] || 'Grams').trim(),
      source: (cols[3] || '').trim(),
      orderCode: (cols[6] || '').trim().replace(/[^0-9]/g, ''),
      notes: (cols[23] || '').trim(),
      storageLocation: (cols[15] || '').trim(),
      allergens: (cols[14] || '').trim(),
    });
  });
  console.log(`  ${oldIngredients.length} ingredients from old CSV`);

  console.log('Reading Hanos XLSX...');
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets['prices'] || wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const hanosByCode = {};
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
  console.log(`  ${Object.keys(hanosByCode).length} products from Hanos`);

  console.log('Merging...');
  const merged = [];
  let matched = 0;

  oldIngredients.forEach(old => {
    const id = crypto.randomUUID();
    const hanos = old.orderCode ? hanosByCode[old.orderCode] : null;
    if (hanos) matched++;

    merged.push([
      id,
      old.name,
      hanos ? hanos.title : '',
      old.category || '',
      old.unit || 'Grams',
      old.source || (hanos ? 'Hanos' : ''),
      old.orderCode || '',
      hanos ? hanos.orderUnit : '',
      hanos ? hanos.orderUnitStandard : '',
      hanos && hanos.price != null ? hanos.price : '',
      hanos ? hanos.orderAmountGrams : 0,
      old.allergens || '',
      old.notes || '',
      old.storageLocation || '',
      'true',
    ]);
  });

  console.log(`  ${merged.length} ingredients total, ${matched} matched with Hanos`);

  console.log('Connecting to Google Sheets...');
  const credentials = JSON.parse(GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Ensure 'ingredients' tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId: DB_SHEET_ID });
  const existing = meta.data.sheets.map(s => s.properties.title);
  if (!existing.includes('ingredients')) {
    console.log('  Creating "ingredients" tab...');
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: DB_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'ingredients' } } }] },
    });
  }

  // Write headers + data
  console.log(`Writing ${merged.length} rows to Google Sheets...`);
  const values = [INGREDIENT_HEADERS, ...merged];
  await sheets.spreadsheets.values.update({
    spreadsheetId: DB_SHEET_ID,
    range: 'ingredients!A1',
    valueInputOption: 'RAW',
    requestBody: { values },
  });

  // Clear any leftover rows
  if (merged.length < 500) {
    try {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: DB_SHEET_ID,
        range: 'ingredients!A' + (merged.length + 2) + ':Z2000',
      });
    } catch (e) { /* ignore */ }
  }

  console.log('Done! Migration complete.');
  console.log(`  Total: ${merged.length} ingredients`);
  console.log(`  Matched with Hanos: ${matched}`);
  console.log(`  Unmatched: ${merged.length - matched}`);
}

main().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
