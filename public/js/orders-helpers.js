// ── ORDER HELPERS — shared state and utility functions for order tabs ──

// State (shared across order tabs)
let orderInventory = {};        // in-stock amounts for dish ingredients (keyed by name lowercase)
let combinedOrderStock = {};   // in-stock amounts for combined order tab (grams, keyed by name lowercase)
let standardInventory = { west: [], centraal: [] };  // per-location weekly base order
let siLoaded = false;
let siLoadCalled = false;
let siSaveTimeout = null;
let currentOrdersTab = 'combined'; // 'combined' | 'standard' | 'batches' | 'ingredientDb'
let currentOrdersLoc = '';  // set on first render from S.currentLoc
let siSearchQuery = '';
let hanosStatus = { configured: false, west: false, centraal: false };
let hanosStatusChecked = false;
let combinedIncludeDishes = true; // toggle: include dish ingredients in combined order

// ── Unit conversion & formatting ──

function toGrams(amount, unit) {
  const u = (unit || '').toLowerCase().replace(/'/g, '');
  if (u === 'kilos' || u === 'kilo' || u === 'kg') return amount * 1000;
  if (u === 'liters' || u === 'liter' || u === 'litres' || u === 'l') return amount * 1000;
  return amount;
}

function normalizeSupplier(s) {
  if (!s) return 'Unknown';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatGrams(g) {
  if (g >= 1000) {
    const kg = Math.round(g / 100) / 10;
    return { amount: kg % 1 === 0 ? kg : kg, unit: 'kg' };
  }
  return { amount: Math.round(g), unit: 'g' };
}

// ── Ingredient lookup (fuzzy match from ingredient DB) ──

function lookupIngredient(name) {
  if (!S.ingredientDb.length || !name) return null;
  const q = name.toLowerCase().trim();
  let match = S.ingredientDb.find(i => i.name.toLowerCase().trim() === q);
  if (match) return match;
  match = S.ingredientDb.find(i => {
    const dn = i.name.toLowerCase().trim();
    return dn.startsWith(q) || q.startsWith(dn);
  });
  if (match) return match;
  const qBase = q.replace(/\s*\(.*\)\s*$/, '').trim();
  if (qBase !== q) {
    match = S.ingredientDb.find(i => i.name.toLowerCase().trim().replace(/\s*\(.*\)\s*$/, '').trim() === qBase);
  }
  return match || null;
}

// ── Stock & storage helpers ──

function getDbStockTotal(db) {
  if (!db || !db.stock) return 0;
  let total = 0;
  if (db.stock.west) total += (db.stock.west.amount || 0);
  if (db.stock.centraal) total += (db.stock.centraal.amount || 0);
  return total;
}

function formatStorageLoc(s) {
  if (!s) return '';
  if (typeof s === 'string') return s;
  if (s.category && s.location) return s.category + ' / ' + s.location;
  if (s.category) return s.category;
  return '';
}

function getStorageCategory(db, building) {
  if (!db || !db.storageLocations) return '';
  const s = db.storageLocations[building];
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.category || '';
}

function renderStorageBadge(db, loc) {
  if (!db || !db.storageLocations) return '';
  const building = loc || currentOrdersLoc || 'west';
  const s = db.storageLocations[building];
  const label = formatStorageLoc(s);
  if (!label) return `<span class="stock-badge" style="cursor:pointer;font-size:10px;color:var(--text2);border:1px dashed var(--border2);" onclick="openStoragePopover('${esc(db.id)}',this)" title="Click to set">No location set</span>`;
  const cat = getStorageCategory(db, building);
  const color = cat ? getStorageColor(cat, building) : '#999';
  return `<span class="stock-badge" style="cursor:pointer;font-size:10px;background:${color}22;color:${color};border:1px solid ${color}44;" onclick="openStoragePopover('${esc(db.id)}',this)" title="Click to edit">${esc(label)}</span>`;
}

// ── Order unit calculation ──

function calcOrderUnits(amountGrams, dbEntry) {
  if (!dbEntry || !dbEntry.orderAmount || dbEntry.orderAmount <= 0) return null;
  const unitGrams = dbEntry.unitRecalc || dbEntry.orderAmount;
  const units = Math.ceil(amountGrams / unitGrams);
  return { units, perUnit: dbEntry.orderAmount, unitType: dbEntry.actualUnit || dbEntry.unit || 'g' };
}
