// One-off script: import Standard Inventory from Google Sheet into data/standard-inventory.json
// Source sheet: 1wyy7FIDWbVY9yu23RQvCg4LDdKfMfu1q9tEfOBAOi_g, gid=761928065
// Column B = ingredient name, Column G = quantity

try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const crypto = require('crypto');

const SOURCE_SHEET_ID = '1wyy7FIDWbVY9yu23RQvCg4LDdKfMfu1q9tEfOBAOi_g';
const SOURCE_GID = 761928065;

const INGREDIENT_DB_SHEET_ID = '1yrYRECESZf6kP5GHwDDR9CmxBtm5G9-gRCPUJqgkzQc';
const INGREDIENT_DB_GID = 1737213788;

const STD_INV_FILE = path.join(__dirname, '..', 'data', 'standard-inventory.json');

function newId() { return crypto.randomUUID(); }

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
  if (!credentials.client_email) throw new Error('GOOGLE_CREDENTIALS not set or invalid');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getTabName(sheets, sheetId, targetGid) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets.properties(title,sheetId)',
  });
  const tab = meta.data.sheets.find(s => s.properties.sheetId === targetGid);
  if (!tab) throw new Error(`Tab with gid=${targetGid} not found in sheet ${sheetId}`);
  return tab.properties.title;
}

async function main() {
  const sheets = getSheetsClient();

  // 1. Find tab names
  const [sourceTab, ingredientTab] = await Promise.all([
    getTabName(sheets, SOURCE_SHEET_ID, SOURCE_GID),
    getTabName(sheets, INGREDIENT_DB_SHEET_ID, INGREDIENT_DB_GID),
  ]);
  console.log(`Source tab: "${sourceTab}"`);
  console.log(`Ingredient DB tab: "${ingredientTab}"`);

  // 2. Read source sheet columns A:G (A=name, D=unit, G=quantity)
  const sourceRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SOURCE_SHEET_ID,
    range: `'${sourceTab}'!A:J`,
  });
  const sourceRows = sourceRes.data.values || [];
  console.log(`Source rows fetched: ${sourceRows.length}`);

  // 3. Read ingredient DB for unit lookup (B=name, F=unit roughly — will match by name)
  const dbRes = await sheets.spreadsheets.values.get({
    spreadsheetId: INGREDIENT_DB_SHEET_ID,
    range: `'${ingredientTab}'!B3:R2000`,
  });
  const dbRows = dbRes.data.values || [];
  console.log(`Ingredient DB rows fetched: ${dbRows.length}`);

  // Build a name→unit map from the ingredient DB
  // Based on server.js /api/ingredients: col0=name, col1=unit, col2=orderCode, col3=supplier
  const unitMap = new Map();
  for (const row of dbRows) {
    const name = (row[0] || '').trim();
    const unit = (row[1] || 'Grams').trim();
    if (name) unitMap.set(name.toLowerCase(), unit);
  }

  // 4. Parse source rows — skip header row, find ingredient entries
  // A=index0(name), B=index1(supplier), C=index2(storage), D=index3(unit), G=index6(amount)
  const items = [];
  for (let i = 1; i < sourceRows.length; i++) { // skip row 0 = header
    const row = sourceRows[i];
    const rawName = (row[0] || '').trim();   // Column A = ingredient name
    const rawUnit = (row[3] || '').trim();   // Column D = unit
    const rawQty  = (row[6] || '').trim();   // Column G = amount required

    if (!rawName || !rawQty) continue;

    const qty = parseFloat(rawQty.replace(',', '.'));
    if (isNaN(qty) || qty <= 0) continue;

    // Use unit from sheet column D, fall back to ingredient DB lookup, then 'Grams'
    const unit = rawUnit || unitMap.get(rawName.toLowerCase()) || 'Grams';

    items.push({ id: newId(), name: rawName, amount: qty, unit });
    console.log(`  ✓ ${rawName} — ${qty} ${unit}`);
  }

  console.log(`\nTotal items to import: ${items.length}`);

  // 5. Write to standard-inventory.json
  fs.writeFileSync(STD_INV_FILE, JSON.stringify(items, null, 2));
  console.log(`\nWritten to ${STD_INV_FILE}`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
