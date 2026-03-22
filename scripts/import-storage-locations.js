// Import storage locations from ingredient CSV into PostgreSQL
// - Creates storage config for Sering West
// - Updates each ingredient's storageLocations.west based on order code match
// Usage: node scripts/import-storage-locations.js <csv-path>

try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
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

// Normalize raw storage strings into { area, spot } pairs
function parseStorageLocation(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // WalkIN, shelf X, lvl Y  →  area: "Walk-in", spot: "Shelf X, Level Y"
  const walkIn = s.match(/walk\s*in,?\s*shelf\s*(\d+),?\s*lvl?\s*(\d+)/i);
  if (walkIn) return { area: 'Walk-in', spot: `Shelf ${walkIn[1]}, Level ${walkIn[2]}` };
  // Just "Walk in" without detail
  if (/^walk\s*in$/i.test(s)) return { area: 'Walk-in', spot: '' };

  // Spicerack X, level Y  →  area: "Spicerack X", spot: "Level Y"
  const spice = s.match(/spicerack\s*(\d+),?\s*level\s*(\d+)/i);
  if (spice) return { area: `Spicerack ${spice[1]}`, spot: `Level ${spice[2]}` };

  // Freezer, LEFT/RIGHT/shelf X  →  area: "Freezer", spot: "Left X" / "Right X" / "Shelf X"
  const freezer = s.match(/freezer,?\s*(left|right|shelf)\s*(\d+)/i);
  if (freezer) {
    const side = freezer[1].charAt(0).toUpperCase() + freezer[1].slice(1).toLowerCase();
    return { area: 'Freezer', spot: `${side} ${freezer[2]}` };
  }

  // Bar 2 Upper  →  area: "Bar area", spot: "Bar 2 Upper"
  if (/^bar\s*2\s*upper$/i.test(s)) return { area: 'Bar area', spot: 'Bar 2 Upper' };
  // Behind Bar 3  →  area: "Bar area", spot: "Behind Bar 3"
  if (/^behind\s*bar\s*3$/i.test(s)) return { area: 'Bar area', spot: 'Behind Bar 3' };
  // Bar3 cartX  →  area: "Bar area", spot: "Bar 3, Cart X"
  const barCart = s.match(/bar\s*3,?\s*cart\s*(\d+)/i);
  if (barCart) return { area: 'Bar area', spot: `Bar 3, Cart ${barCart[1]}` };

  // Upper Middle Island  →  area: "Dry storage", spot: "Upper Middle Island"
  if (/upper\s*middle\s*island/i.test(s)) return { area: 'Dry storage', spot: 'Upper Middle Island' };
  // Under Workbench  →  area: "Dry storage", spot: "Under Workbench"
  if (/under\s*workbench/i.test(s)) return { area: 'Dry storage', spot: 'Under Workbench' };
  // Under Dehydrator  →  area: "Dry storage", spot: "Under Dehydrator"
  if (/under\s*dehydrator/i.test(s)) return { area: 'Dry storage', spot: 'Under Dehydrator' };

  // Liquors room  →  area: "Liquors room", spot: ""
  if (/liquors?\s*room/i.test(s)) return { area: 'Liquors room', spot: '' };

  // KitchenTWO/THREE  →  area: "Kitchen", spot: raw
  if (/kitchen/i.test(s)) return { area: 'Kitchen', spot: s };

  // Fallback
  return { area: s, spot: '' };
}

// Default colors for areas
const AREA_COLORS = {
  'Walk-in': '#4CAF50',
  'Spicerack 1': '#FF9800',
  'Spicerack 2': '#FFC107',
  'Freezer': '#2196F3',
  'Bar area': '#9C27B0',
  'Dry storage': '#795548',
  'Liquors room': '#607D8B',
  'Kitchen': '#F44336',
};

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node scripts/import-storage-locations.js <csv-path>');
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n');

  // Row 3 (index 2) is the header
  // Data starts at row 4 (index 3)
  // Col B (index 1) = Name
  // Col G (index 6) = order code
  // Col R (index 17) = SERING - Storage location

  // Build map: orderCode → { area, spot }
  // and:       nameLower → { area, spot }
  const codeToStorage = new Map();
  const nameToStorage = new Map();
  const allAreas = new Map(); // area → Set of spots

  for (let i = 3; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = (cols[1] || '').trim();
    const orderCode = (cols[6] || '').trim();
    const rawStorage = (cols[17] || '').trim();

    if (!name || !rawStorage) continue;

    const parsed = parseStorageLocation(rawStorage);
    if (!parsed) continue;

    // Collect spots per area
    if (!allAreas.has(parsed.area)) allAreas.set(parsed.area, new Set());
    if (parsed.spot) allAreas.get(parsed.area).add(parsed.spot);

    // Map by order code (for DB matching)
    if (orderCode && !orderCode.startsWith('http') && !orderCode.startsWith('/')) {
      codeToStorage.set(orderCode, parsed);
    }
    // Also map by name
    nameToStorage.set(name.toLowerCase(), parsed);
  }

  console.log(`\nParsed ${codeToStorage.size} order code mappings and ${nameToStorage.size} name mappings`);
  console.log(`\nStorage areas found:`);

  // Build storage config for west
  const areaOrder = ['Walk-in', 'Spicerack 1', 'Spicerack 2', 'Freezer', 'Bar area', 'Dry storage', 'Liquors room', 'Kitchen'];
  const westConfig = [];

  for (const area of areaOrder) {
    if (!allAreas.has(area)) continue;
    const spots = [...allAreas.get(area)].sort();
    const color = AREA_COLORS[area] || '#999';
    westConfig.push({ name: area, color, spots });
    console.log(`  ${area} (${color}): ${spots.length} spots — ${spots.join(', ') || '(none)'}`);
  }
  // Add any remaining areas not in the predefined order
  for (const [area, spots] of allAreas) {
    if (areaOrder.includes(area)) continue;
    const sortedSpots = [...spots].sort();
    westConfig.push({ name: area, color: '#999', spots: sortedSpots });
    console.log(`  ${area} (#999): ${sortedSpots.length} spots — ${sortedSpots.join(', ') || '(none)'}`);
  }

  // Save storage config
  console.log(`\nSaving storage config for west (${westConfig.length} areas)...`);
  const existingConfig = await prisma.storageConfig.findUnique({ where: { id: 'default' } });
  const config = existingConfig ? existingConfig.config : {};
  config.west = westConfig;
  await prisma.storageConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default', config },
    update: { config },
  });
  console.log('Storage config saved.');

  // Update ingredients' storageLocations.west
  const ingredients = await prisma.ingredient.findMany();
  console.log(`\nUpdating storage locations on ${ingredients.length} ingredients...`);

  let updated = 0;
  let skipped = 0;

  for (const ing of ingredients) {
    // Try to match by order code first, then by name
    let parsed = null;
    if (ing.orderCode) parsed = codeToStorage.get(ing.orderCode);
    if (!parsed) parsed = nameToStorage.get(ing.name.toLowerCase());
    if (!parsed) { skipped++; continue; }

    const storLocs = ing.storageLocations || {};
    storLocs.west = { category: parsed.area, location: parsed.spot };

    await prisma.ingredient.update({
      where: { id: ing.id },
      data: { storageLocations: storLocs },
    });
    updated++;
  }

  console.log(`\nDone! ${updated} ingredients updated, ${skipped} skipped (no match).`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
