// Import standard inventory from CSV into PostgreSQL
// Usage: node scripts/import-standard-inventory.js <csv-path> [location]
// CSV format: Ingredient,Supplier,Storage location,Unit,Units required,Amount per container,Amount required (in grams or ML),...

try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { cols.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

async function main() {
  const csvPath = process.argv[2];
  const location = process.argv[3] || 'west';

  if (!csvPath) {
    console.error('Usage: node scripts/import-standard-inventory.js <csv-path> [location]');
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').slice(1); // skip header

  const items = [];
  const seen = new Set();

  for (const line of lines) {
    const cols = parseCsvLine(line);
    const name = cols[0];
    if (!name) continue;

    const unit = cols[3] || 'Grams';
    const amountRaw = parseFloat((cols[6] || '0').replace(',', '.')) || 0;
    if (amountRaw <= 0) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      id: crypto.randomUUID(),
      name,
      amount: amountRaw,
      unit,
      location,
    });
    console.log(`  + ${name} — ${amountRaw} ${unit}`);
  }

  console.log(`\nImporting ${items.length} items for location "${location}"...`);

  await prisma.$transaction([
    prisma.standardInventory.deleteMany({ where: { location } }),
    prisma.standardInventory.createMany({ data: items }),
  ]);

  console.log(`Done! ${items.length} items imported for ${location}.`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
