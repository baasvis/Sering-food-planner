import { S, DAYS, MEALS, STORAGE, LOCATIONS, ALLERGENS, INGREDIENT_TYPES, INGREDIENT_CATEGORIES, INGREDIENT_TYPE_TO_GROUP, ALL_CATEGORIES, PRICE_LEVELS, STORAGE_CATEGORIES, getStorageConfigForLoc, getStorageColor, ACCOMPANIMENTS, rebuildStorageCategories } from './state';
import { scheduleSave, toast, toastError, apiGet, apiPost, loadIngredientDb, ingredientDbLoaded, ingredientDbError } from './utils';
import { rebuildPlanner, isBatchCooked, calcRequired, calcRequiredBreakdown, calcIngredientsFromRecipe, batchHasRecipe, locationBadge, storageBadge, storageBadgeClass, logisticsBadge, logisticsBadgeClass, typeBadge, typeBadgeClass, TYPES, getToday, dateToStr, strToDate, chipClass } from './core';
import { showModal, closeModal, esc } from './modal';
import { ingredientDbFull, openIngredientModal, openStoragePopover, renderIngredientDbTab } from './ingredient-db';
import { trackEvent } from './telemetry';
import type { Ingredient, Batch, Location } from '@shared/types';

// ── Local type aliases for order data ──

/** Storage location value — either a plain string (legacy) or an object with category/location */
type StorageLocValue = string | { category?: string; location?: string };

/**
 * Runtime stock entry shape — the Prisma JSON field stores objects with amount+date,
 * even though the shared Ingredient type declares LocationStock as Record<string, number>.
 * This local type reflects the actual runtime shape used by the frontend.
 */
interface StockEntry { amount: number; date?: string }
type RuntimeStock = Record<string, StockEntry>;
type RuntimeStorageLocations = Record<string, StorageLocValue>;

/**
 * Extended Ingredient type reflecting actual runtime JSON shapes for stock and storageLocations.
 * The shared Ingredient type uses simpler primitives; at runtime Prisma JSON fields are richer.
 */
/**
 * Extended Ingredient type reflecting actual runtime JSON shapes for stock and storageLocations.
 * The shared Ingredient type uses simpler primitives; at runtime Prisma JSON fields are richer.
 */
interface IngredientRuntime extends Omit<Ingredient, 'stock' | 'storageLocations'> {
  stock: RuntimeStock;
  storageLocations: RuntimeStorageLocations;
}

/** Cast S.ingredientDb items to the runtime shape (stock/storageLocations are richer JSON at runtime) */
function ingredientDb(): IngredientRuntime[] {
  return S.ingredientDb as unknown as IngredientRuntime[];
}

/** A single item in a Hanos cart request */
interface HanosItem {
  name: string;
  orderCode: string;
  quantity: number;
  unit: string;
  unitLabel: string;
  price: number;
}

/** Aggregated ingredient entry in the combined order */
interface CombinedOrderEntry {
  name: string;
  totalGrams: number;
  standardGrams: number;
  dishGrams: number;
  dishes: string[];
}

/** Aggregated ingredient in the batch ingredients tab */
interface BatchIngredientAgg {
  name: string;
  amount: number;
  unit: string;
  source: string;
  perBatch: Array<{ batchId: string; batchName: string; amount: number; unit: string }>;
}

/** Hanos add-to-cart result entry */
interface HanosResult {
  orderCode: string;
  success: boolean;
  error?: string;
}

/** Partial ingredient shape used in updateStocktakeToOrder (from DOM data) */
interface StocktakeOrderInfo {
  orderUnitSize: number;
  unit: string;
  orderUnit: string;
}

// ── ORDER OVERVIEW ────────────────────────────────────────

// State
export let orderInventory = {};        // in-stock amounts for dish ingredients (keyed by name lowercase)
export let combinedOrderStock = {};   // in-stock amounts for combined order tab (grams, keyed by name lowercase)
export let currentOrdersTab = 'combined'; // 'combined' | 'standard' | 'batches' | 'ingredientDb'
export let siSearchQuery = '';
export let hanosStatus = { configured: false, west: false, centraal: false };
export let hanosStatusChecked = false;
export let combinedIncludeDishes = true; // toggle: include dish ingredients in combined order
export let batchIngredientToggles = {}; // { batchId: true/false } for Batch Ingredients tab
export let batchIngredientTogglesInitialized = false; // reset when location changes
export const BATCH_COLORS = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#dc2626', '#0891b2', '#c026d3', '#4f46e5'];

// ── Shared helpers ────────────────────────────────────────

// Convert to base units: grams for weight, ml for volume, raw count for pieces
export function toBaseUnit(amount: number, unit: string) {
  const u = (unit || '').toLowerCase().replace(/'/g, '');
  if (u === 'kilos' || u === 'kilo' || u === 'kg') return amount * 1000;
  if (u === 'liters' || u === 'liter' || u === 'litres' || u === 'l') return amount * 1000;
  return amount;
}

export function normalizeSupplier(s: string) {
  if (!s) return 'Unknown';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Format a base-unit amount with the right suffix (g/kg, ml/L, or pcs)
export function formatAmount(val: number, baseUnit: string) {
  const u = (baseUnit || 'g').toLowerCase();
  if (u === 'ml' || u === 'liters' || u === 'l') {
    if (val >= 1000) {
      const l = Math.round(val / 100) / 10;
      return { amount: l, unit: 'L' };
    }
    return { amount: Math.round(val), unit: 'ml' };
  }
  if (u === 'pieces' || u === 'pcs' || u === 'amount') {
    return { amount: Math.round(val), unit: 'pcs' };
  }
  // Default: weight (g/kg)
  if (val >= 1000) {
    const kg = Math.round(val / 100) / 10;
    return { amount: kg, unit: 'kg' };
  }
  return { amount: Math.round(val), unit: 'g' };
}

export function lookupIngredient(name: string): IngredientRuntime | null {
  const db = ingredientDb();
  if (!db.length || !name) return null;
  const q = name.toLowerCase().trim();
  let match = db.find(i => i.name.toLowerCase().trim() === q);
  if (match) return match;
  match = db.find(i => {
    const dn = i.name.toLowerCase().trim();
    return dn.startsWith(q) || q.startsWith(dn);
  });
  if (match) return match;
  const qBase = q.replace(/\s*\(.*\)\s*$/, '').trim();
  if (qBase !== q) {
    match = db.find(i => i.name.toLowerCase().trim().replace(/\s*\(.*\)\s*$/, '').trim() === qBase);
  }
  return match || null;
}

export function getDbStockTotal(db: IngredientRuntime | null | undefined) {
  if (!db || !db.stock) return 0;
  let total = 0;
  if (db.stock.west) total += (db.stock.west.amount || 0);
  if (db.stock.centraal) total += (db.stock.centraal.amount || 0);
  return total;
}

/** Check if stock has been explicitly counted (even if amount is 0) */
export function hasDbStockEntry(db: IngredientRuntime | null | undefined) {
  if (!db || !db.stock) return false;
  // Stock entries have a `date` field when explicitly counted via stocktake
  return !!(db.stock.west?.date || db.stock.centraal?.date);
}

export function formatStorageLoc(s: StorageLocValue | null | undefined) {
  if (!s) return '';
  if (typeof s === 'string') return s; // backward compat
  if (s.category && s.location) return s.category + ' / ' + s.location;
  if (s.category) return s.category;
  return '';
}

export function getStorageCategory(db: IngredientRuntime | null | undefined, building: string) {
  if (!db || !db.storageLocations) return '';
  const s = db.storageLocations[building];
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.category || '';
}

export function renderStorageBadge(db: IngredientRuntime | null | undefined, loc?: string) {
  if (!db || !db.storageLocations) return '';
  const building = loc || S.currentLoc;
  const s = db.storageLocations[building];
  const label = formatStorageLoc(s);
  if (!label) return `<span class="stock-badge" style="cursor:pointer;font-size:10px;color:var(--text2);border:1px dashed var(--border2);" onclick="openStoragePopover('${esc(db.id)}',this)" title="Click to set">No location set</span>`;
  const cat = getStorageCategory(db, building);
  const color = cat ? getStorageColor(cat, building) : '#999';
  return `<span class="stock-badge" style="cursor:pointer;font-size:10px;background:${color}22;color:${color};border:1px solid ${color}44;" onclick="openStoragePopover('${esc(db.id)}',this)" title="Click to edit">${esc(label)}</span>`;
}

export function calcOrderUnits(amountBase: number, dbEntry: { orderUnitSize: number; unit?: string; orderUnit?: string } | null | undefined) {
  if (!dbEntry || !dbEntry.orderUnitSize || dbEntry.orderUnitSize <= 0) return null;
  const units = Math.ceil(amountBase / dbEntry.orderUnitSize);
  return { units, perUnit: dbEntry.orderUnitSize, unitType: dbEntry.unit || 'g' };
}

// ── Standard Inventory (now reads from ingredient targetStock) ──

// Get ingredients that have targetStock set for a location
export function getStandardInventoryItems(loc: string): IngredientRuntime[] {
  return ingredientDb().filter(ing => {
    const ts = ing.targetStock;
    return ts && ts[loc] && ts[loc] > 0;
  });
}

export function updateSiSearch(val: string) {
  siSearchQuery = val;
  const sugContainer = document.getElementById('si-suggestions');
  if (!sugContainer) return;
  const query = val.toLowerCase().trim();
  const loc = S.currentLoc;
  const addedIds = new Set(getStandardInventoryItems(loc).map(i => i.id));
  const suggestions = query.length >= 2
    ? ingredientDb().filter(i => i.name.toLowerCase().includes(query) || (i.orderCode && i.orderCode.toLowerCase().includes(query))).slice(0, 8)
    : [];
  let html = suggestions.map(ing => {
    const isAdded = addedIds.has(ing.id);
    return `<div class="si-suggestion${isAdded ? ' si-suggestion-added' : ''}" ${!isAdded ? `onclick="addToStandardInventory('${esc(ing.id)}')"` : ''}>
      <span class="si-sug-name">${esc(ing.name)}</span>
      <span class="si-sug-meta">${ing.supplier ? esc(ing.supplier) + ' · ' : ''}${ing.orderCode ? esc(ing.orderCode) + ' · ' : ''}${ing.unit || 'g'}</span>
      ${isAdded ? '<span style="color:var(--green);font-size:11px;font-weight:600;">\u2713 added</span>' : ''}
    </div>`;
  }).join('');
  sugContainer.innerHTML = html;
  sugContainer.style.display = html ? 'block' : 'none';
}

export function hideSiSuggestions() {
  setTimeout(() => {
    siSearchQuery = '';
    const sugContainer = document.getElementById('si-suggestions');
    if (sugContainer) { sugContainer.innerHTML = ''; sugContainer.style.display = 'none'; }
    const input = document.getElementById('si-search-input');
    if (input) input.value = '';
  }, 200);
}

export async function addToStandardInventory(ingredientId: string) {
  const loc = S.currentLoc;
  const ing = ingredientDb().find(i => i.id === ingredientId);
  if (!ing) return;
  // Set a default target of 0 (user will edit)
  if (!ing.targetStock) ing.targetStock = {};
  ing.targetStock[loc] = 1; // placeholder — user edits the real target
  siSearchQuery = '';
  try {
    await apiPost('/api/ingredients/target-stock', { ingredientId, location: loc, amount: 1 });
  } catch (e: unknown) { toastError('Failed to add: ' + (e instanceof Error ? e.message : 'Unknown error')); }
  renderOrders();
}

export async function removeSiItem(ingredientId: string) {
  const loc = S.currentLoc;
  const ing = ingredientDb().find(i => i.id === ingredientId);
  if (ing && ing.targetStock) delete ing.targetStock[loc];
  try {
    await apiPost('/api/ingredients/target-stock', { ingredientId, location: loc, amount: null });
  } catch (e: unknown) { toastError('Failed to remove: ' + (e instanceof Error ? e.message : 'Unknown error')); }
  renderOrders();
}

export let siTargetTimeout: ReturnType<typeof setTimeout> | null = null;
export function updateSiTarget(ingredientId: string, val: string) {
  const loc = S.currentLoc;
  const ing = ingredientDb().find(i => i.id === ingredientId);
  if (!ing) return;
  if (!ing.targetStock) ing.targetStock = {};
  // Input is in order units — convert to base units for storage
  const orderUnits = parseFloat(val) || 0;
  const baseAmount = ing.orderUnitSize > 0 ? orderUnits * ing.orderUnitSize : orderUnits;
  ing.targetStock[loc] = baseAmount;
  _updateSiToOrder(ingredientId, ing);
  clearTimeout(siTargetTimeout);
  siTargetTimeout = setTimeout(async () => {
    try {
      await apiPost('/api/ingredients/target-stock', { ingredientId, location: loc, amount: baseAmount });
    } catch (e: unknown) { toastError('Failed to save target: ' + (e instanceof Error ? e.message : 'Unknown error')); }
  }, 800);
}

export let siStockTimeout: ReturnType<typeof setTimeout> | null = null;
export function updateSiStock(ingredientId: string, val: string) {
  const loc = S.currentLoc;
  const ing = ingredientDb().find(i => i.id === ingredientId);
  if (!ing) return;
  if (!ing.stock) ing.stock = {};
  // Input is in order units — convert to base units for storage
  const orderUnits = parseFloat(val) || 0;
  const baseAmount = ing.orderUnitSize > 0 ? orderUnits * ing.orderUnitSize : orderUnits;
  ing.stock[loc] = { amount: baseAmount, date: new Date().toISOString().slice(0, 10) };
  _updateSiToOrder(ingredientId, ing);
  clearTimeout(siStockTimeout);
  siStockTimeout = setTimeout(async () => {
    try {
      await apiPost('/api/ingredients/stock', { ingredientId, location: loc, amount: baseAmount });
    } catch (e: unknown) { toastError('Failed to save stock: ' + (e instanceof Error ? e.message : 'Unknown error')); }
  }, 800);
}

/** Inline update the to-order cell for a standard inventory row */
export function _updateSiToOrder(ingredientId: string, ing: IngredientRuntime) {
  const loc = S.currentLoc;
  const row = document.querySelector(`tr[data-si-id="${ingredientId}"]`);
  if (!row) return;
  const toOrderCell = row.querySelector('.si-to-order');
  if (!toOrderCell) return;

  const targetBase = (ing.targetStock && ing.targetStock[loc]) || 0;
  const stockBase = (ing.stock && ing.stock[loc]) ? (ing.stock[loc].amount || 0) : 0;
  const deficit = Math.max(0, targetBase - stockBase);
  const hasOrderUnit = ing.orderUnitSize > 0;
  const orderUnitLabel = ing.orderUnit || '';
  const unitSuffix = hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, ing.unit); return f.unit; })();

  if (deficit > 0) {
    const calc = hasOrderUnit ? calcOrderUnits(deficit, ing) : null;
    toOrderCell.innerHTML = calc
      ? `<span class="to-order-positive">${calc.units}x ${esc(unitSuffix)}</span>`
      : (() => { const f = formatAmount(deficit, ing.unit); return `<span class="to-order-positive">${f.amount} ${f.unit}</span>`; })();
  } else {
    toOrderCell.innerHTML = '<span class="to-order-zero">\u2713 full</span>';
  }
}

// ── Tab switching ─────────────────────────────────────────

export function switchOrdersTab(tab: string) {
  currentOrdersTab = tab;
  renderOrders();
}

/** Reset batch toggles so they re-read from batch.orderFor on next render (called on SSE patch) */
export function resetBatchToggles() {
  batchIngredientTogglesInitialized = false;
}

// ── Main render ────────────────────────────────────────────

export function renderOrders() {
  if (!ingredientDbLoaded) {
    document.getElementById('screen-orders').innerHTML = '<div class="empty">Loading ingredient database...</div>';
    setTimeout(renderOrders, 500);
    return;
  }

  rebuildStorageCategories(S.currentLoc);
  checkHanosStatus();

  const tabBar = `<div class="order-tab-bar">
    <button class="order-tab-btn${currentOrdersTab === 'combined' ? ' active' : ''}" onclick="switchOrdersTab('combined')">🛒 Combined Order</button>
    <button class="order-tab-btn${currentOrdersTab === 'standard' ? ' active' : ''}" onclick="switchOrdersTab('standard')">📦 Set Standard Inventory</button>
    <button class="order-tab-btn${currentOrdersTab === 'batches' ? ' active' : ''}" onclick="switchOrdersTab('batches')">🍽️ Batch Ingredients</button>
    <button class="order-tab-btn${currentOrdersTab === 'ingredientDb' ? ' active' : ''}" onclick="switchOrdersTab('ingredientDb')">🗄️ Ingredient Database</button>
  </div>`;

  let content;
  if (currentOrdersTab === 'standard') content = renderStandardInventoryTab();
  else if (currentOrdersTab === 'batches') content = renderDishesTab();
  else if (currentOrdersTab === 'ingredientDb') content = renderIngredientDbTab();
  else content = renderCombinedOrderTab();

  const screenEl = document.getElementById('screen-orders');
  screenEl.innerHTML = tabBar + content;
  // UX: prevent scroll-wheel from changing number inputs, Enter moves to next input
  setupOrderInputUX(screenEl);
  // Delegated click handler for individual Hanos add-to-cart buttons (avoids esc/quote issues in onclick)
  setupHanosBtnDelegation(screenEl);
}

function setupHanosBtnDelegation(container: HTMLElement) {
  container.addEventListener('click', (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.hanos-btn[data-order-code]') as HTMLElement;
    if (!btn) return;
    e.preventDefault();
    hanosAddSingle(btn.dataset.orderCode, btn.dataset.ingName);
  });
}

/** Prevent mousewheel changing number inputs + Enter-to-next-input on order screens */
function setupOrderInputUX(container: HTMLElement) {
  container.querySelectorAll('input.order-stock-input, input.stocktake-input').forEach((input: HTMLInputElement) => {
    input.addEventListener('wheel', (e: WheelEvent) => { e.preventDefault(); }, { passive: false });
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const allInputs = Array.from(container.querySelectorAll('input.order-stock-input, input.stocktake-input')) as HTMLInputElement[];
        const idx = allInputs.indexOf(input);
        if (idx >= 0 && idx < allInputs.length - 1) allInputs[idx + 1].focus();
      }
    });
  });
}

// ── Standard Inventory tab ────────────────────────────────

export function renderStandardInventoryTab() {
  const curLoc = S.currentLoc;
  const siItems = getStandardInventoryItems(curLoc);

  // Build enriched list with stock, target, deficit, and order calculations
  // Stock and target are stored in base units (g/ml/pcs) but displayed in order units when possible
  const ingList = siItems.map(ing => {
    const targetBase = ing.targetStock[curLoc] || 0;
    const stockBase = (ing.stock && ing.stock[curLoc]) ? (ing.stock[curLoc].amount || 0) : 0;
    const deficit = Math.max(0, targetBase - stockBase);
    const orderCalc = deficit > 0 ? calcOrderUnits(deficit, ing) : null;
    const hasOrderUnit = ing.orderUnitSize > 0;
    // Convert to order units for display
    const stockUnits = hasOrderUnit ? Math.round(stockBase / ing.orderUnitSize * 10) / 10 : stockBase;
    const targetUnits = hasOrderUnit ? Math.round(targetBase / ing.orderUnitSize * 10) / 10 : targetBase;
    return {
      ...ing,
      targetBase,
      stockBase,
      stockUnits,
      targetUnits,
      hasOrderUnit,
      deficit,
      orderCalc,
    };
  }).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

  // Calculate total estimated order cost
  let totalValue = 0;
  ingList.forEach(ing => {
    if (ing.orderCalc && ing.orderPrice) {
      totalValue += ing.orderCalc.units * ing.orderPrice;
    }
  });

  // Group by storage category
  const byStorage: Record<string, typeof ingList> = {};
  ingList.forEach(ing => {
    const cat = getStorageCategory(ing, curLoc) || 'Unsorted';
    if (!byStorage[cat]) byStorage[cat] = [];
    byStorage[cat].push(ing);
  });
  const storageCatOrder = Object.keys(STORAGE_CATEGORIES);
  const storageOrder = [...storageCatOrder.filter(c => byStorage[c]), ...Object.keys(byStorage).filter(c => !storageCatOrder.includes(c))];

  let itemsHtml = '';
  if (siItems.length === 0) {
    itemsHtml = '<div class="empty">No items yet. Search above to add ingredients to the standard inventory.</div>';
  } else {
    storageOrder.forEach(storageCat => {
      const items = byStorage[storageCat];
      const codesForCopy = items.filter(i => i.orderCode && !i.orderCode.startsWith('http')).map(i => i.orderCode);
      const catColor = getStorageColor(storageCat, curLoc);

      itemsHtml += `<div class="storage-group" style="margin-bottom:16px;border-left:4px solid ${catColor};padding-left:10px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span class="storage-group-dot" style="background:${catColor};"></span>
          <span style="font-weight:600;font-size:14px;">${esc(storageCat)}</span>
          <span style="font-size:12px;color:var(--text2);">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
          ${codesForCopy.length ? `<button class="copy-all-btn" onclick="copySiOrderCodes('${esc(storageCat)}')">Copy all codes</button>` : ''}
        </div>
        <div style="overflow-x:auto;"><table class="ing-table">
        <thead><tr>
          <th>Ingredient</th>
          <th>Storage</th>
          <th>Order code</th>
          <th>Unit / Price</th>
          <th>In stock</th>
          <th>Target</th>
          <th>To order</th>
          <th></th>
        </tr></thead><tbody>`;

      items.forEach(ing => {
        const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));
        let codeDisplay;
        if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">\u2014</span>';
        else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link \u2197</a>`;
        else codeDisplay = `<span class="order-code">${esc(ing.orderCode)}</span>`;

        const orderUnitLabel = ing.orderUnit ? esc(ing.orderUnit) : '';
        const unitPrice = (orderUnitLabel || 'unit') + (ing.orderPrice ? ' \u00B7 \u20AC' + Number(ing.orderPrice).toFixed(2) : '');

        // Display in order units when possible, otherwise in base units
        const unitSuffix = ing.hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, ing.unit); return f.unit; })();
        const stockColor = ing.stockBase >= ing.targetBase ? 'var(--green)' : ing.stockBase > 0 ? 'var(--orange, #e67e22)' : 'var(--red)';

        const deficitDisplay = ing.deficit > 0
          ? (ing.orderCalc
            ? `<span class="to-order-positive">${ing.orderCalc.units}x ${unitSuffix}</span>`
            : (() => { const f = formatAmount(ing.deficit, ing.unit); return `<span class="to-order-positive">${f.amount} ${f.unit}</span>`; })())
          : '<span class="to-order-zero">\u2713 full</span>';

        itemsHtml += `<tr data-si-id="${esc(ing.id)}">
          <td style="font-weight:500;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" onclick="openIngredientModal('${esc(ing.name)}')">${esc(ing.name)}</td>
          <td>${renderStorageBadge(ing)}</td>
          <td>${codeDisplay}</td>
          <td style="font-size:12px;">${unitPrice}</td>
          <td style="white-space:nowrap;">
            <input class="order-stock-input" type="number" min="0" step="1" value="${ing.stockUnits || ''}" placeholder="0" style="width:55px;" oninput="updateSiStock('${esc(ing.id)}', this.value)" />
            <span class="order-units" style="margin-left:2px;">x ${unitSuffix}</span>
          </td>
          <td style="white-space:nowrap;">
            <input class="order-stock-input" type="number" min="0" step="1" value="${ing.targetUnits > 0 ? ing.targetUnits : ''}" placeholder="0" style="width:55px;" oninput="updateSiTarget('${esc(ing.id)}', this.value)" />
            <span class="order-units" style="margin-left:2px;">x ${unitSuffix}</span>
          </td>
          <td class="si-to-order">${deficitDisplay}</td>
          <td></td>
          <td><button class="btn btn-danger btn-sm" onclick="removeSiItem('${esc(ing.id)}')">Remove</button></td>
        </tr>`;
      });

      itemsHtml += `</tbody></table></div></div>`;
    });
  }

  return `
    <div>
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Set Standard Inventory &mdash; ${esc(curLoc === 'west' ? 'Sering West' : 'Sering Centraal')}</span>
        ${totalValue > 0 ? `<span style="font-size:13px;font-weight:600;">Estimated order: \u20AC${totalValue.toFixed(2)}</span>` : ''}
      </div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">Set target stock levels for each ingredient. The order is calculated automatically from the deficit (target \u2212 current stock).</p>
      <div style="position:relative;margin-bottom:16px;">
        <input
          id="si-search-input"
          type="text"
          class="dish-search"
          style="margin-bottom:0;"
          placeholder="Search ingredients to add..."
          oninput="updateSiSearch(this.value)"
          onblur="hideSiSuggestions()"
          autocomplete="off"
        />
        <div id="si-suggestions" class="si-suggestions" style="display:none;"></div>
      </div>
      ${itemsHtml}
    </div>
  `;
}

// ── Dishes tab ────────────────────────────────────────────

/** Initialise batchIngredientToggles from batch.orderFor (server state) — idempotent */
function ensureBatchTogglesInitialized(loc: string) {
  if (batchIngredientTogglesInitialized) return;
  const eligible = S.batches.filter(b => b.location === loc && !isBatchCooked(b) && batchHasRecipe(b));
  batchIngredientToggles = {};
  eligible.forEach(b => {
    batchIngredientToggles[b.id] = !!b.orderFor;
  });
  batchIngredientTogglesInitialized = true;
}

/** Persist a single batch's orderFor to the server */
async function persistBatchOrderFor(batchId: string, orderFor: boolean) {
  // Update local state immediately
  const batch = S.batches.find(b => b.id === batchId);
  if (batch) batch.orderFor = orderFor;
  // Save to server
  try {
    await apiPost(`/api/batches/${batchId}`, { orderFor }, 'PATCH');
  } catch (e) {
    console.warn('Failed to save batch orderFor:', e);
  }
}

/** Toggle a batch on/off in the Batch Ingredients tab */
export function toggleBatchIngredient(batchId: string) {
  batchIngredientToggles[batchId] = !batchIngredientToggles[batchId];
  const isOn = !!batchIngredientToggles[batchId];
  // Update toggle row visual
  const row = document.querySelector(`.batch-toggle-row[data-batch-id="${batchId}"]`);
  if (row) {
    row.classList.toggle('on', isOn);
    const sw = row.querySelector('.batch-toggle-switch');
    if (sw) sw.classList.toggle('on', isOn);
  }
  // Update header count
  const curLoc = S.currentLoc;
  const eligible = S.batches.filter(b => b.location === curLoc && !isBatchCooked(b) && batchHasRecipe(b));
  const onCount = eligible.filter(b => batchIngredientToggles[b.id]).length;
  const header = document.querySelector('.section-title span');
  if (header && header.textContent.includes('selected')) {
    header.textContent = `Batches at ${curLoc === 'west' ? 'Sering West' : 'Sering Centraal'} (${onCount}/${eligible.length} selected)`;
  }
  // Persist to server (syncs across devices via SSE batch update)
  persistBatchOrderFor(batchId, isOn);
  // Re-render ingredient table
  const container = document.getElementById('batch-ingredients-table');
  if (container) container.innerHTML = renderBatchIngredientTable();
}

/** Toggle the "Include batch ingredients" switch on Combined Order */
export function toggleCombinedIncludeDishes() {
  combinedIncludeDishes = !combinedIncludeDishes;
  renderOrders();
}

/** Toggle all batches on or off */
export function toggleAllBatchIngredients(on: boolean) {
  const curLoc = S.currentLoc;
  const eligible = S.batches.filter(b => b.location === curLoc && !isBatchCooked(b) && batchHasRecipe(b));
  eligible.forEach(b => {
    batchIngredientToggles[b.id] = on;
    persistBatchOrderFor(b.id, !!on);
  });
  const container = document.getElementById('batch-ingredients-table');
  if (container) container.innerHTML = renderBatchIngredientTable();
  // Update toggle row + switch visuals
  document.querySelectorAll('.batch-toggle-row').forEach(el => {
    el.classList.toggle('on', on);
    const sw = el.querySelector('.batch-toggle-switch');
    if (sw) sw.classList.toggle('on', on);
  });
  // Update header count
  const onCount = on ? eligible.length : 0;
  const header = document.querySelector('.section-title span');
  if (header && header.textContent.includes('selected')) {
    header.textContent = `Batches at ${curLoc === 'west' ? 'Sering West' : 'Sering Centraal'} (${onCount}/${eligible.length} selected)`;
  }
}

export function renderDishesTab() {
  const curLoc = S.currentLoc;

  // Uncooked batches at this location with recipe data
  const eligible = S.batches.filter(b => b.location === curLoc && !isBatchCooked(b) && batchHasRecipe(b));

  // Initialize toggles from localStorage (or fall back to orderFor for new batches)
  ensureBatchTogglesInitialized(curLoc);

  // Assign colors to batches (stable order by id)
  const batchColorMap: Record<string, string> = {};
  eligible.forEach((b: Batch, i: number) => { batchColorMap[b.id] = BATCH_COLORS[i % BATCH_COLORS.length]; });

  // ── Batch toggle list ──
  const onCount = eligible.filter(b => batchIngredientToggles[b.id]).length;
  const dishesWithSheets = eligible.filter(d => d.recipeSheetId);
  let html = `<div style="margin-bottom:16px;">
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Batches at ${curLoc === 'west' ? 'Sering West' : 'Sering Centraal'} (${onCount}/${eligible.length} selected)</span>
      <div style="display:flex;align-items:center;gap:8px;">
        ${dishesWithSheets.length ? `<button class="copy-all-btn" onclick="refreshAllRecipes()">↻ Refresh recipe data</button>` : ''}
        <button class="copy-all-btn" onclick="toggleAllBatchIngredients(true)">All on</button>
        <button class="copy-all-btn" onclick="toggleAllBatchIngredients(false)">All off</button>
      </div>
    </div>`;

  if (!eligible.length) {
    html += `<div class="empty">No batches with recipe data at this location.</div>`;
  } else {
    html += `<div class="batch-toggle-list">`;
    eligible.forEach(b => {
      const isOn = !!batchIngredientToggles[b.id];
      const color = batchColorMap[b.id];
      const typeBadge = b.type ? `<span class="batch-type-pill" style="background:${color}20;color:${color};border:1px solid ${color}40;">${esc(b.type)}</span>` : '';
      const cookLabel = b.cookDate ? b.cookDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_: string, _y: string, m: string, d: string) => `${parseInt(d)}/${parseInt(m)}`) : '';
      const cookBadge = cookLabel ? `<span style="font-size:11px;color:${b.stock > 0 ? 'var(--green)' : 'var(--blue)'};font-weight:500;">${cookLabel}</span>` : '';
      html += `<div class="batch-toggle-row${isOn ? ' on' : ''}" data-batch-id="${esc(b.id)}" onclick="toggleBatchIngredient('${esc(b.id)}')">
        <span class="batch-toggle-dot" style="background:${color};"></span>
        <span class="batch-toggle-name">${esc(b.name)}</span>
        ${typeBadge}
        ${cookBadge}
        <span class="batch-toggle-switch${isOn ? ' on' : ''}" data-batch-id="${esc(b.id)}"></span>
      </div>`;
    });
    html += `</div>`;
  }

  // ── Ingredient table (rendered separately so toggles can update it) ──
  html += `<div id="batch-ingredients-table">${renderBatchIngredientTable()}</div>`;
  html += `</div>`;

  if (ingredientDbError || S.ingredientDb.length === 0) {
    html += `<div style="font-size:11px;color:var(--text2);margin-top:12px;padding:8px;border-top:1px solid var(--border);">
      ${ingredientDbError ? `<span style="color:var(--red);">Ingredient DB error: ${esc(ingredientDbError)}</span>` : ''}
      ${S.ingredientDb.length === 0 && !ingredientDbError ? 'Ingredient database is empty. <button class="btn btn-sm" onclick="loadIngredientDb().then(renderOrders)">Retry</button>' : ''}
    </div>`;
  }

  return html;
}

/** Render just the ingredient aggregation table for toggled-on batches */
export function renderBatchIngredientTable() {
  const curLoc = S.currentLoc;
  const eligible = S.batches.filter(b => b.location === curLoc && !isBatchCooked(b) && batchHasRecipe(b));

  // Assign colors (same stable order as toggle list)
  const batchColorMap: Record<string, string> = {};
  eligible.forEach((b: Batch, i: number) => { batchColorMap[b.id] = BATCH_COLORS[i % BATCH_COLORS.length]; });

  const activeBatches = eligible.filter(b => batchIngredientToggles[b.id]);

  // Aggregate ingredients with per-batch breakdown
  const combined: Record<string, BatchIngredientAgg> = {};
  activeBatches.forEach(dish => {
    const ings = calcIngredientsFromRecipe(dish);
    ings.forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      if (!combined[key]) combined[key] = { name: ing.name, amount: 0, unit: ing.unit, source: ing.source, perBatch: [] };
      combined[key].amount += ing.amount;
      combined[key].perBatch.push({ batchId: dish.id, batchName: dish.name, amount: ing.amount, unit: ing.unit });
      if (!combined[key].source && ing.source) combined[key].source = ing.source;
    });
  });

  const ingList = Object.values(combined).map(ing => {
    const db = lookupIngredient(ing.name);
    const amtInGrams = toBaseUnit(ing.amount, ing.unit);
    return {
      ...ing,
      db,
      amountInGrams: amtInGrams,
      supplier: normalizeSupplier((db && db.supplier) || ing.source || ''),
      orderCode: db ? db.orderCode : '',
      orderCalc: db ? calcOrderUnits(amtInGrams, db) : null,
    };
  }).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

  if (!activeBatches.length) {
    return `<div class="empty" style="margin-top:12px;">Toggle batches above to see their ingredient requirements.</div>`;
  }

  if (!ingList.length) {
    return `<div class="empty" style="margin-top:12px;">Selected batches have no recipe ingredients.</div>`;
  }

  // Group by storage category
  const byStorage: Record<string, typeof ingList> = {};
  ingList.forEach(ing => {
    const cat = getStorageCategory(ing.db, curLoc) || 'Unsorted';
    if (!byStorage[cat]) byStorage[cat] = [];
    byStorage[cat].push(ing);
  });
  const storageCatOrder = Object.keys(STORAGE_CATEGORIES);
  const storageOrder = [...storageCatOrder.filter(c => byStorage[c]), ...Object.keys(byStorage).filter(c => !storageCatOrder.includes(c))];

  const hanosAllBatchBtn = isHanosEnabled() && ingList.length ? `<button class="hanos-bulk-btn" onclick="hanosConfirmBulkBatches()" title="Send all batch ingredients to Hanos cart">🛒 Send all to Hanos</button>` : '';
  let html = `<div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
    <span style="font-weight:600;font-size:14px;">Ingredients (${ingList.length} items from ${activeBatches.length} batch${activeBatches.length !== 1 ? 'es' : ''})</span>
    ${hanosAllBatchBtn}
  </div>`;

  storageOrder.forEach(storageCat => {
    const items = byStorage[storageCat];
    const codesForCopy = items.filter(i => i.orderCode && !i.orderCode.startsWith('http')).map(i => i.orderCode);
    const catColor = getStorageColor(storageCat, curLoc);
    const hanosItemsForCat = isHanosEnabled() ? items.filter(i => i.orderCode && !i.orderCode.startsWith('http')) : [];
    const hanosBatchBtn = hanosItemsForCat.length ? `<button class="hanos-bulk-btn" onclick="hanosConfirmBulkBatches('${esc(storageCat)}')" title="Add all items to Hanos cart">🛒 Send to Hanos</button>` : '';

    html += `<div class="storage-group" data-storage-cat="${esc(storageCat)}" style="margin-bottom:16px;border-left:4px solid ${catColor};padding-left:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <span class="storage-group-dot" style="background:${catColor};"></span>
        <span style="font-weight:600;font-size:14px;">${esc(storageCat)}</span>
        <span style="font-size:12px;color:var(--text2);">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
        ${codesForCopy.length ? `<button class="copy-all-btn" onclick="copyDishOrderCodes('${esc(storageCat)}')">Copy all codes</button>` : ''}
        ${hanosBatchBtn}
      </div>
      <div style="overflow-x:auto;"><table class="ing-table">
      <thead><tr>
        <th>Ingredient</th><th>Category</th><th>Storage</th><th>Order code</th>
        <th>Needed</th><th>In stock</th><th>To order</th><th>Breakdown</th>
      </tr></thead><tbody>`;

    items.forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));
      const amtNeededBase = Math.round(ing.amountInGrams);
      const db = ing.db;
      const hasOrderUnit = db && db.orderUnitSize > 0;
      const orderUnitLabel = db && db.orderUnit ? esc(db.orderUnit) : '';
      const unitSuffix = hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, db ? db.unit : 'g'); return f.unit; })();

      let codeDisplay;
      if (!db) codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
      else if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">no code</span>';
      else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link \u2197</a>`;
      else codeDisplay = `<span class="order-code" title="Click to select">${esc(ing.orderCode)}</span>`;

      const neededCalc = hasOrderUnit ? calcOrderUnits(amtNeededBase, db) : null;
      const neededDisplay = neededCalc
        ? `<span class="order-amt">${neededCalc.units}x</span> <span class="order-units">${unitSuffix}</span>`
        : (() => { const f = formatAmount(amtNeededBase, db ? db.unit : 'g'); return `<span class="order-amt">${f.amount}</span> <span class="order-units">${f.unit}</span>`; })();

      const dbStock = getDbStockTotal(db);
      const dbStockExists = hasDbStockEntry(db);
      const hasManualStock = orderInventory[key] !== undefined;
      const stockDisplayVal = hasManualStock ? orderInventory[key] : (dbStockExists ? (hasOrderUnit ? Math.round(dbStock / db.orderUnitSize * 10) / 10 : dbStock) : '');
      const stockLabel = (!hasManualStock && dbStockExists) ? ' <span style="font-size:9px;color:var(--blue);vertical-align:super;">DB</span>' : '';
      const stockInput = `<input class="order-stock-input" type="number" min="0" step="1" value="${stockDisplayVal}" placeholder="0" oninput="updateOrderStock('${esc(key)}',this.value)" /><span class="order-units" style="margin-left:2px;">${unitSuffix}</span>${stockLabel}`;

      const effectiveStockBase = hasManualStock
        ? (hasOrderUnit ? (parseFloat(orderInventory[key]) || 0) * db.orderUnitSize : (parseFloat(orderInventory[key]) || 0))
        : dbStock;
      const hasStockValue = hasManualStock || dbStockExists;
      const toOrderBase = Math.max(0, amtNeededBase - effectiveStockBase);
      const toOrderCalc = hasOrderUnit ? calcOrderUnits(toOrderBase, db) : null;

      let toOrderDisplay;
      if (!hasStockValue) {
        toOrderDisplay = `<span style="color:var(--text2);font-size:11px;">enter stock \u2192</span>`;
      } else if (toOrderBase <= 0) {
        toOrderDisplay = '<span class="to-order-zero">\u2713 enough</span>';
      } else if (toOrderCalc) {
        const hanosBtnBatch = (isHanosEnabled() && ing.orderCode && !isUrl && toOrderCalc.units > 0)
          ? ` <button class="hanos-btn" data-order-code="${esc(ing.orderCode)}" data-ing-name="${esc(ing.name)}" title="Add to Hanos cart">🛒</button>`
          : '';
        toOrderDisplay = `<span class="to-order-positive">${toOrderCalc.units}x ${unitSuffix}</span>${hanosBtnBatch}`;
      } else {
        const f = formatAmount(toOrderBase, db ? db.unit : 'g');
        toOrderDisplay = `<span class="to-order-positive">${f.amount} ${f.unit}</span>`;
      }

      // Per-batch colored breakdown
      let breakdownHtml = '';
      ing.perBatch.forEach(pb => {
        const color = batchColorMap[pb.batchId] || 'var(--text2)';
        const pbBase = toBaseUnit(pb.amount, pb.unit);
        let label;
        if (hasOrderUnit) {
          const calc = calcOrderUnits(pbBase, db);
          label = calc ? `${calc.units}x ${unitSuffix}` : `${pb.amount} ${pb.unit}`;
        } else {
          const f = formatAmount(pbBase, db ? db.unit : 'g');
          label = `${f.amount} ${f.unit}`;
        }
        const shortName = pb.batchName.length > 18 ? pb.batchName.slice(0, 16) + '\u2026' : pb.batchName;
        breakdownHtml += `<span class="batch-breakdown-label" style="--batch-color:${color};">● ${label} ${esc(shortName)}</span> `;
      });

      html += `<tr data-stock-key="${esc(key)}" data-needed="${amtNeededBase}" data-unit="${esc(db ? db.unit : 'g')}">
        <td style="font-weight:500;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" onclick="openIngredientModal('${esc(ing.name)}')">${esc(ing.name)}</td>
        <td style="font-size:12px;">${db && db.category ? esc(db.category) : '\u2014'}</td>
        <td>${renderStorageBadge(db)}</td>
        <td>${codeDisplay}</td>
        <td>${neededDisplay}</td>
        <td>${stockInput}</td>
        <td class="to-order-cell">${toOrderDisplay}</td>
        <td class="batch-breakdown-cell">${breakdownHtml}</td>
      </tr>`;
    });

    html += `</tbody></table></div></div>`;
  });

  return html;
}

// ── Combined Order tab ────────────────────────────────────

export function renderCombinedOrderTab() {
  const curLoc = S.currentLoc;
  const combined: Record<string, CombinedOrderEntry> = {};

  // Use the same per-batch toggles as the Batch Ingredients tab (initialized from localStorage)
  ensureBatchTogglesInitialized(curLoc);
  const orderedDishes = S.batches.filter(d =>
    d.location === curLoc && !isBatchCooked(d) && !!batchIngredientToggles[d.id]
  );

  function addToMap(name: string, amtGrams: number, isStandard: boolean, dishName: string | null) {
    const key = name.toLowerCase().trim();
    if (!combined[key]) combined[key] = { name, totalGrams: 0, standardGrams: 0, dishGrams: 0, dishes: [] };
    combined[key].totalGrams += amtGrams;
    if (isStandard) {
      combined[key].standardGrams += amtGrams;
    } else if (dishName) {
      combined[key].dishGrams += amtGrams;
      if (!combined[key].dishes.includes(dishName)) combined[key].dishes.push(dishName);
    }
  }

  // Add dish ingredients (if toggle is on)
  if (combinedIncludeDishes) {
    orderedDishes.forEach(dish => {
      calcIngredientsFromRecipe(dish).forEach(ing => {
        addToMap(ing.name, toBaseUnit(ing.amount, ing.unit), false, dish.name);
      });
    });
  }

  // Add standard inventory items — ingredients with targetStock for current location
  getStandardInventoryItems(curLoc).forEach(ing => {
    const target = ing.targetStock[curLoc] || 0;
    const currentStock = (ing.stock && ing.stock[curLoc]) ? (ing.stock[curLoc].amount || 0) : 0;
    const deficit = Math.max(0, target - currentStock);
    if (deficit <= 0) return;
    addToMap(ing.name, deficit, true, null);
  });

  if (!Object.keys(combined).length) {
    return `<div class="empty">No items to order. Add items to Standard Inventory or flag batches for ordering in the Week plan.</div>`;
  }

  const ingList = Object.values(combined).sort((a: CombinedOrderEntry, b: CombinedOrderEntry) => a.name.localeCompare(b.name)).map(ing => {
    const db = lookupIngredient(ing.name);
    return {
      ...ing,
      db,
      supplier: normalizeSupplier((db && db.supplier) || ''),
      orderCode: db ? db.orderCode : '',
      orderCalc: db ? calcOrderUnits(ing.totalGrams, db) : null,
    };
  });

  // Group by storage category (current building) instead of supplier
  const byStorage: Record<string, typeof ingList> = {};
  ingList.forEach(ing => {
    const cat = getStorageCategory(ing.db, curLoc) || 'Unsorted';
    if (!byStorage[cat]) byStorage[cat] = [];
    byStorage[cat].push(ing);
  });
  const storageCatOrder = Object.keys(STORAGE_CATEGORIES);
  const storageOrder = [...storageCatOrder.filter(c => byStorage[c]), ...Object.keys(byStorage).filter(c => !storageCatOrder.includes(c))];

  // Calculate total value
  let totalValue = 0;
  ingList.forEach(ing => {
    if (!ing.db || !ing.db.orderPrice) return;
    const dbStock = getDbStockTotal(ing.db);
    const key = ing.name.toLowerCase().trim();
    const hasManual = combinedOrderStock[key] !== undefined;
    const effectiveStock = hasManual ? (parseFloat(combinedOrderStock[key]) || 0) : dbStock;
    const toOrderGrams = Math.max(0, ing.totalGrams - effectiveStock);
    const orderAmtGrams = (hasManual || hasDbStockEntry(ing.db)) ? toOrderGrams : ing.totalGrams;
    const calc = calcOrderUnits(orderAmtGrams, ing.db);
    if (calc && calc.units > 0) totalValue += calc.units * ing.db.orderPrice;
  });

  // Price alert banner
  const alertItems = ingList.filter(i => i.db && i.db.priceAlert);
  let html = `<div style="margin-bottom:20px;">`;

  if (alertItems.length) {
    html += `<div class="price-alert-banner">
      <strong>Price alerts:</strong> ${alertItems.map(i => esc(i.name)).join(', ')} had significant price increases.
    </div>`;
  }

  const hanosAllCombinedBtn = isHanosEnabled() && ingList.length ? `<button class="hanos-bulk-btn" onclick="hanosConfirmBulk()" title="Send entire combined order to Hanos cart">🛒 Send all to Hanos</button>` : '';
  html += `<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>Combined Order &mdash; ${esc(curLoc === 'west' ? 'Sering West' : 'Sering Centraal')}</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:13px;font-weight:600;">${totalValue > 0 ? 'Estimated: \u20AC' + totalValue.toFixed(2) : ''}</span>
        ${hanosAllCombinedBtn}
      </div>
    </div>
    <div class="order-toggle-bar" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
      <label class="order-toggle${combinedIncludeDishes ? ' on' : ''}" onclick="toggleCombinedIncludeDishes()">
        <span class="tbox${combinedIncludeDishes ? ' on' : ''}"><span class="tknob"></span></span>
        Include batch ingredients
      </label>
      <button class="btn btn-sm" style="background:var(--blue);color:white;" onclick="startStocktake()">📋 Do stocktake</button>
    </div>`;

  storageOrder.forEach(storageCat => {
    const items = byStorage[storageCat];
    const codesForCopy = items.filter(i => i.orderCode && !i.orderCode.startsWith('http')).map(i => i.orderCode);

    const catColor = getStorageColor(storageCat, curLoc);
    const hanosItems = isHanosEnabled() ? items.filter(i => i.orderCode && !i.orderCode.startsWith('http')) : [];
    const hanosBulkBtn = hanosItems.length ? `<button class="hanos-bulk-btn" onclick="hanosConfirmBulk('${esc(storageCat)}')" title="Add all items to Hanos cart">🛒 Send to Hanos</button>` : '';

    html += `<div class="storage-group" data-storage-cat="${esc(storageCat)}" style="margin-bottom:16px;border-left:4px solid ${catColor};padding-left:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <span class="storage-group-dot" style="background:${catColor};"></span>
        <span style="font-weight:600;font-size:14px;">${esc(storageCat)}</span>
        <span style="font-size:12px;color:var(--text2);">(${items.length} item${items.length !== 1 ? 's' : ''})</span>
        ${codesForCopy.length ? `<button class="copy-all-btn" onclick="copyCombinedOrderCodes('${esc(storageCat)}')">Copy all codes</button>` : ''}
        ${hanosBulkBtn}
      </div>
      <div style="overflow-x:auto;"><table class="ing-table">
      <thead><tr>
        <th>Ingredient</th>
        <th>Category</th>
        <th>Storage</th>
        <th>Order code</th>
        <th>Unit / Price</th>
        <th style="cursor:pointer;" title="Click a row to see breakdown">Needed</th>
        <th>In stock</th>
        <th>To order</th>
      </tr></thead><tbody>`;

    items.forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      const db = ing.db;
      const hasOrderUnit = db && db.orderUnitSize > 0;
      const orderUnitLabel = db && db.orderUnit ? esc(db.orderUnit) : '';
      const unitSuffix = hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, db ? db.unit : 'g'); return f.unit; })();
      const isUrl = ing.orderCode && (ing.orderCode.startsWith('http') || ing.orderCode.startsWith('www'));

      let codeDisplay;
      if (!db) codeDisplay = '<span style="color:var(--red);font-size:10px;opacity:.7;">not in DB</span>';
      else if (!ing.orderCode) codeDisplay = '<span style="color:var(--text2);font-size:11px;">no code</span>';
      else if (isUrl) codeDisplay = `<a href="${esc(ing.orderCode.startsWith('http') ? ing.orderCode : 'https://'+ing.orderCode)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue);">Order link \u2197</a>`;
      else codeDisplay = `<span class="order-code">${esc(ing.orderCode)}</span>`;

      const unitPrice = db ? (db.orderUnit ? esc(db.orderUnit) : '') + (db.orderPrice ? ' \u00B7 \u20AC' + Number(db.orderPrice).toFixed(2) : '') : '';

      // Needed in order units
      const neededCalc = hasOrderUnit ? calcOrderUnits(ing.totalGrams, db) : null;
      const neededDisplay = neededCalc
        ? `<span class="order-amt">${neededCalc.units}x</span> <span class="order-units">${unitSuffix}</span>`
        : (() => { const f = formatAmount(ing.totalGrams, db ? db.unit : 'g'); return `<span class="order-amt">${f.amount}</span> <span class="order-units">${f.unit}</span>`; })();

      // Breakdown (shown on click) — in order units when possible
      const parts = [];
      if (ing.standardGrams > 0) {
        const sc = hasOrderUnit ? calcOrderUnits(ing.standardGrams, db) : null;
        parts.push(sc
          ? `<span class="combined-part combined-standard">${sc.units}x ${unitSuffix} standard</span>`
          : (() => { const f = formatAmount(ing.standardGrams, db ? db.unit : 'g'); return `<span class="combined-part combined-standard">${f.amount}${f.unit} standard</span>`; })());
      }
      if (ing.dishGrams > 0) {
        const dc = hasOrderUnit ? calcOrderUnits(ing.dishGrams, db) : null;
        parts.push(dc
          ? `<span class="combined-part combined-dishes">${dc.units}x ${unitSuffix} ${esc(ing.dishes.join(', '))}</span>`
          : (() => { const f = formatAmount(ing.dishGrams, db ? db.unit : 'g'); return `<span class="combined-part combined-dishes">${f.amount}${f.unit} ${esc(ing.dishes.join(', '))}</span>`; })());
      }
      const breakdownHtml = parts.length ? `<div class="breakdown-detail" style="display:none;font-size:11px;margin-top:2px;">${parts.join(' + ')}</div>` : '';

      // Stock in order units
      const dbStock = getDbStockTotal(db);
      const dbStockExists = hasDbStockEntry(db);
      const hasManualStock = combinedOrderStock[key] !== undefined;
      const stockDisplayVal = hasManualStock ? combinedOrderStock[key] : (dbStockExists ? (hasOrderUnit ? Math.round(dbStock / db.orderUnitSize * 10) / 10 : dbStock) : '');
      const stockLabel = (!hasManualStock && dbStockExists) ? ' <span style="font-size:9px;color:var(--blue);vertical-align:super;">DB</span>' : '';
      const stockInput = `<input class="order-stock-input" type="number" min="0" step="1" value="${stockDisplayVal}" placeholder="0" oninput="updateCombinedOrderStock('${esc(key)}',this.value)" /><span class="order-units" style="margin-left:2px;">${unitSuffix}</span>${stockLabel}`;

      // To order
      const effectiveStockBase = hasManualStock
        ? (hasOrderUnit ? (parseFloat(combinedOrderStock[key]) || 0) * db.orderUnitSize : (parseFloat(combinedOrderStock[key]) || 0))
        : dbStock;
      const hasStockValue = hasManualStock || dbStockExists;
      const toOrderBase = Math.max(0, ing.totalGrams - effectiveStockBase);
      const toOrderCalc = hasOrderUnit ? calcOrderUnits(toOrderBase, db) : null;

      let toOrderDisplay;
      if (!hasStockValue) {
        toOrderDisplay = `<span style="color:var(--text2);font-size:11px;">enter stock \u2192</span>`;
      } else if (toOrderBase <= 0) {
        toOrderDisplay = '<span class="to-order-zero">\u2713 enough</span>';
      } else if (toOrderCalc) {
        const hanosBtn = (isHanosEnabled() && ing.orderCode && !isUrl && toOrderCalc.units > 0)
          ? ` <button class="hanos-btn" data-order-code="${esc(ing.orderCode)}" data-ing-name="${esc(ing.name)}" title="Add to Hanos cart">🛒</button>`
          : '';
        toOrderDisplay = `<span class="to-order-positive">${toOrderCalc.units}x ${unitSuffix}</span>${hanosBtn}`;
      } else {
        const f = formatAmount(toOrderBase, db ? db.unit : 'g');
        toOrderDisplay = `<span class="to-order-positive">${f.amount} ${f.unit}</span>`;
      }

      // g/piece input for items without orderUnitSize
      const isStukNoWeight = db && db.orderCode && (!db.orderUnitSize || db.orderUnitSize <= 0);
      if (isStukNoWeight && ing.totalGrams > 0 && toOrderBase > 0) {
        toOrderDisplay += ` <input class="order-stock-input gpstuk-input" type="number" min="1" step="1" placeholder="g/piece" title="Fill in grams per piece to calculate order units" onchange="saveGramsPerPiece('${esc(db.id)}','${esc(key)}',this.value)" style="width:65px;" />`;
      }

      const priceAlertIcon = (db && db.priceAlert) ? ' <span style="color:var(--red);font-size:11px;" title="Price increased">\u25B2</span>' : '';

      html += `<tr data-combined-key="${esc(key)}" data-needed="${ing.totalGrams}" data-dbname="${esc(ing.name)}">
        <td style="font-weight:500;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" onclick="openIngredientModal('${esc(ing.name)}')">${esc(ing.name)}${priceAlertIcon}</td>
        <td style="font-size:12px;">${db && db.category ? esc(db.category) : '\u2014'}</td>
        <td>${renderStorageBadge(db)}</td>
        <td>${codeDisplay}</td>
        <td style="font-size:12px;">${unitPrice}</td>
        <td style="cursor:pointer;" onclick="this.querySelector('.breakdown-detail')&&(this.querySelector('.breakdown-detail').style.display=this.querySelector('.breakdown-detail').style.display==='none'?'block':'none')">
          ${neededDisplay}
          ${breakdownHtml}
        </td>
        <td>${stockInput}</td>
        <td class="to-order-cell">${toOrderDisplay}</td>
      </tr>`;
    });

    html += `</tbody></table></div></div>`;
  });

  html += `</div>`;
  return html;
}

// ── Copy helpers ──────────────────────────────────────────

export function copyOrderCodes(supplier: string) {
  trackEvent('order_copy', supplier);
  const curLoc = S.currentLoc;
  ensureBatchTogglesInitialized(curLoc);
  const items = [];
  S.batches.filter(d => d.location === curLoc && !isBatchCooked(d) && !!batchIngredientToggles[d.id]).forEach(dish => {
    calcIngredientsFromRecipe(dish).forEach(ing => {
      const db = lookupIngredient(ing.name);
      if (db && db.orderCode && !db.orderCode.startsWith('http') && (db.supplier || '').toLowerCase().includes(supplier.toLowerCase())) {
        if (!items.includes(db.orderCode)) items.push(db.orderCode);
      }
    });
  });
  if (items.length) navigator.clipboard.writeText(items.join('\n')).then(() => toast(items.length + ' order codes copied'));
}

export function copyDishOrderCodes(storageCat: string) {
  const curLoc = S.currentLoc;
  ensureBatchTogglesInitialized(curLoc);
  const items = new Set();
  S.batches.filter(d => d.location === curLoc && !isBatchCooked(d) && !!batchIngredientToggles[d.id]).forEach(dish => {
    calcIngredientsFromRecipe(dish).forEach(ing => {
      const db = lookupIngredient(ing.name);
      if (db && db.orderCode && !db.orderCode.startsWith('http')) {
        const cat = getStorageCategory(db, curLoc) || 'Unsorted';
        if (cat === storageCat) items.add(db.orderCode);
      }
    });
  });
  const arr = [...items];
  if (arr.length) navigator.clipboard.writeText(arr.join('\n')).then(() => toast(arr.length + ' order codes copied'));
}

export function copySiOrderCodes(storageCat: string) {
  const curLoc = S.currentLoc;
  const items = new Set();
  getStandardInventoryItems(curLoc).forEach(ing => {
    if (ing.orderCode && !ing.orderCode.startsWith('http')) {
      const cat = getStorageCategory(ing, curLoc) || 'Unsorted';
      if (cat === storageCat) items.add(ing.orderCode);
    }
  });
  const arr = [...items];
  if (arr.length) navigator.clipboard.writeText(arr.join('\n')).then(() => toast(arr.length + ' order codes copied'));
}

export function copyCombinedOrderCodes(supplier: string) {
  const curLoc = S.currentLoc;
  ensureBatchTogglesInitialized(curLoc);
  const items = new Set();
  S.batches.filter(d => d.location === curLoc && !isBatchCooked(d) && !!batchIngredientToggles[d.id]).forEach(dish => {
    calcIngredientsFromRecipe(dish).forEach(ing => {
      const db = lookupIngredient(ing.name);
      if (db && db.orderCode && !db.orderCode.startsWith('http') && normalizeSupplier(db.supplier || '').toLowerCase().includes(supplier.toLowerCase())) {
        items.add(db.orderCode);
      }
    });
  });
  getStandardInventoryItems(S.currentLoc).forEach(ing => {
    if (ing.orderCode && !ing.orderCode.startsWith('http') && normalizeSupplier(ing.supplier || '').toLowerCase().includes(supplier.toLowerCase())) {
      items.add(ing.orderCode);
    }
  });
  const arr = [...items];
  if (arr.length) navigator.clipboard.writeText(arr.join('\n')).then(() => toast(arr.length + ' order codes copied'));
}

// ── Hanos integration ────────────────────────────────────

export async function checkHanosStatus() {
  if (hanosStatusChecked) return;
  hanosStatusChecked = true;
  try {
    const prev = hanosStatus.configured;
    hanosStatus = await apiGet('/api/hanos/status');
    // Re-render if status changed (first load with credentials configured)
    if (!prev && hanosStatus.configured) renderOrders();
  } catch (e: unknown) {
    console.error('Hanos status check failed:', e);
    hanosStatus = { configured: false, west: false, centraal: false };
  }
}

export function isHanosEnabled() {
  const loc = S.currentLoc;
  return hanosStatus[loc] || false;
}

/** Collect all Hanos items from the combined order table that need ordering */
export function collectHanosItems(storageCat: string | null | undefined): HanosItem[] {
  const rows = document.querySelectorAll('.ing-table tr[data-combined-key]');
  const items: HanosItem[] = [];
  rows.forEach(row => {
    // If filtering by storage category, check the group
    if (storageCat) {
      const group = row.closest('.storage-group');
      if (!group || !group.dataset.storageCat || group.dataset.storageCat !== storageCat) return;
    }
    const key = row.dataset.combinedKey;
    const dbName = row.dataset.dbname;
    const db = dbName ? lookupIngredient(dbName) : null;
    if (!db || !db.orderCode || db.orderCode.startsWith('http')) return;

    // Calculate order units for this row — stock values are in order units, convert to base
    const neededBase = parseFloat(row.dataset.needed) || 0;
    const dbStock = getDbStockTotal(db);
    const hasManual = combinedOrderStock[key] !== undefined;
    const effectiveStockBase = hasManual
      ? (db.orderUnitSize > 0 ? (parseFloat(combinedOrderStock[key]) || 0) * db.orderUnitSize : (parseFloat(combinedOrderStock[key]) || 0))
      : dbStock;
    const hasStockValue = hasManual || hasDbStockEntry(db);
    const toOrderBase = hasStockValue ? Math.max(0, neededBase - effectiveStockBase) : neededBase;
    const calc = calcOrderUnits(toOrderBase, db);
    if (!calc || calc.units <= 0) return;

    items.push({
      name: db.name,
      orderCode: db.orderCode,
      quantity: calc.units,
      unit: 'ST',
      unitLabel: db.orderUnit || '',
      price: db.orderPrice || 0,
    });
  });
  return items;
}

/** Send a single item to Hanos cart */
export async function hanosAddSingle(orderCode: string | undefined, name: string | undefined) {
  if (!name || !orderCode) return;
  const db = lookupIngredient(name);
  if (!db) return;

  // Calculate quantity from the DOM row — stock is in order units, convert to base
  const key = name.toLowerCase().trim();
  const row = document.querySelector(`[data-combined-key="${key}"]`) || document.querySelector(`[data-stock-key="${key}"]`);
  let quantity = 1;
  if (row) {
    const neededBase = parseFloat(row.dataset.needed) || 0;
    const dbStock = getDbStockTotal(db);
    const stockObj = row.dataset.combinedKey ? combinedOrderStock : orderInventory;
    const hasManual = stockObj[key] !== undefined;
    const effectiveStockBase = hasManual
      ? (db.orderUnitSize > 0 ? (parseFloat(stockObj[key]) || 0) * db.orderUnitSize : (parseFloat(stockObj[key]) || 0))
      : dbStock;
    const hasStockValue = hasManual || hasDbStockEntry(db);
    const toOrderBase = hasStockValue ? Math.max(0, neededBase - effectiveStockBase) : neededBase;
    const calc = calcOrderUnits(toOrderBase, db);
    if (calc && calc.units > 0) quantity = calc.units;
  }

  toast(`Adding ${name} to Hanos cart...`);
  try {
    const resp = await apiPost('/api/hanos/add-to-cart', { items: [{ orderCode, quantity, unit: 'ST' }], location: S.currentLoc });
    if (resp.ok > 0) {
      toast(`Added ${quantity}x ${name} to Hanos cart`);
      if (row) (row as HTMLElement).classList.add('hanos-sent');
    } else {
      const err = resp.results && resp.results[0] ? resp.results[0].error : 'Unknown error';
      toastError(`Failed: ${err}`);
      if (row) {
        (row as HTMLElement).classList.add('hanos-failed');
        const toOrderCell = row.querySelector('.to-order-positive');
        if (toOrderCell && !row.querySelector('.hanos-fail-badge')) {
          toOrderCell.insertAdjacentHTML('afterend', ` <span class="hanos-fail-badge" title="${esc(err)}">⚠ failed</span>`);
        }
      }
    }
  } catch (e: unknown) {
    toastError('Hanos error: ' + (e instanceof Error ? e.message : 'Unknown error'));
    if (row) (row as HTMLElement).classList.add('hanos-failed');
  }
}

/** Show confirmation modal for bulk Hanos add (combined order) */
export function hanosConfirmBulk(storageCat?: string) {
  trackEvent('hanos_send_bulk');
  const items = collectHanosItems(storageCat);
  if (!items.length) {
    toast('No items with order codes and quantities to send');
    return;
  }
  showHanosConfirmModal(items, storageCat, 'combined');
}

/** Collect Hanos items from batch ingredients tab */
export function collectHanosBatchItems(storageCat: string | null | undefined): HanosItem[] {
  const rows = document.querySelectorAll('.ing-table tr[data-stock-key]');
  const items: HanosItem[] = [];
  rows.forEach(row => {
    if (storageCat) {
      const group = row.closest('.storage-group');
      if (!group || !group.dataset.storageCat || group.dataset.storageCat !== storageCat) return;
    }
    const key = row.dataset.stockKey;
    const db = key ? lookupIngredient(key) : null;
    if (!db || !db.orderCode || db.orderCode.startsWith('http')) return;

    const neededBase = parseFloat(row.dataset.needed) || 0;
    const dbStock = getDbStockTotal(db);
    const hasManual = orderInventory[key] !== undefined;
    const effectiveStockBase = hasManual
      ? (db.orderUnitSize > 0 ? (parseFloat(orderInventory[key]) || 0) * db.orderUnitSize : (parseFloat(orderInventory[key]) || 0))
      : dbStock;
    const hasStockValue = hasManual || hasDbStockEntry(db);
    const toOrderBase = hasStockValue ? Math.max(0, neededBase - effectiveStockBase) : neededBase;
    const calc = calcOrderUnits(toOrderBase, db);
    if (!calc || calc.units <= 0) return;

    items.push({
      name: db.name,
      orderCode: db.orderCode,
      quantity: calc.units,
      unit: 'ST',
      unitLabel: db.orderUnit || '',
      price: db.orderPrice || 0,
    });
  });
  return items;
}

/** Show confirmation modal for batch ingredients Hanos add */
export function hanosConfirmBulkBatches(storageCat?: string) {
  const items = collectHanosBatchItems(storageCat);
  if (!items.length) {
    toast('No items with order codes and quantities to send');
    return;
  }
  showHanosConfirmModal(items, storageCat, 'batches');
}

/** Shared confirmation modal with €200 warning */
export function showHanosConfirmModal(items: HanosItem[], storageCat: string | undefined, source: string) {
  // Check for items over €200
  const expensiveItems = items.filter(i => i.price && i.quantity * i.price > 200);

  let warningHtml = '';
  if (expensiveItems.length) {
    warningHtml = `<div style="background:var(--red-bg, #fde8e8);border:1px solid var(--red);border-radius:var(--radius);padding:10px 14px;margin-bottom:12px;">
      <strong style="color:var(--red);">High-value items (over \u20AC200):</strong>
      <ul style="margin:6px 0 0;padding-left:18px;font-size:12px;">
        ${expensiveItems.map(i => `<li><strong>${esc(i.name)}</strong>: ${i.quantity}x \u00D7 \u20AC${i.price.toFixed(2)} = <strong>\u20AC${(i.quantity * i.price).toFixed(2)}</strong></li>`).join('')}
      </ul>
    </div>`;
  }

  const listHtml = items.map(i => {
    const total = i.price ? i.quantity * i.price : 0;
    const isExpensive = total > 200;
    return `<tr${isExpensive ? ' style="background:var(--red-bg, #fde8e8);"' : ''}>
      <td style="font-weight:500;">${esc(i.name)}</td>
      <td style="font-family:monospace;font-size:12px;">${esc(i.orderCode)}</td>
      <td style="text-align:right;font-weight:600;">${i.quantity}x</td>
      <td style="font-size:12px;color:var(--text2);">${esc(i.unitLabel)}</td>
      <td style="text-align:right;font-size:12px;${isExpensive ? 'color:var(--red);font-weight:600;' : ''}">${total > 0 ? '\u20AC' + total.toFixed(2) : ''}</td>
    </tr>`;
  }).join('');

  const label = storageCat ? esc(storageCat) : 'all groups';
  const totalCost = items.reduce((sum: number, i: HanosItem) => sum + (i.price ? i.quantity * i.price : 0), 0);

  showModal(`
    <h3 style="margin-bottom:12px;">Add to Hanos Cart</h3>
    <p style="font-size:13px;margin-bottom:12px;">Send <strong>${items.length} item(s)</strong> from ${label} to the Hanos cart:</p>
    ${warningHtml}
    <div style="max-height:300px;overflow-y:auto;margin-bottom:12px;">
      <table class="ing-table" style="font-size:12px;">
        <thead><tr><th>Item</th><th>Code</th><th>Qty</th><th>Unit</th><th>Est. cost</th></tr></thead>
        <tbody>${listHtml}</tbody>
      </table>
    </div>
    ${totalCost > 0 ? `<p style="font-size:13px;font-weight:600;margin-bottom:12px;">Total estimated: \u20AC${totalCost.toFixed(2)}</p>` : ''}
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn btn-sm" onclick="closeModal()">Cancel</button>
      <button class="btn btn-sm" style="background:var(--blue);color:#fff;border-color:var(--blue);" onclick="hanosExecuteFromModal('${esc(source)}','${esc(storageCat || '')}')">
        ${expensiveItems.length ? 'Confirm & Send' : 'Send to Hanos'}
      </button>
    </div>
  `);
}

/** Execute from the shared modal */
export async function hanosExecuteFromModal(source: string, storageCat: string) {
  const items = source === 'batches'
    ? collectHanosBatchItems(storageCat || null)
    : collectHanosItems(storageCat || null);
  if (!items.length) { closeModal(); return; }

  const modalBody = document.querySelector('.modal');
  if (modalBody) {
    modalBody.innerHTML = `
      <h3 style="margin-bottom:12px;">Sending to Hanos...</h3>
      <p style="font-size:13px;">Adding ${items.length} item(s) to cart. Please wait...</p>
      <div style="margin-top:16px;height:4px;background:var(--border);border-radius:2px;overflow:hidden;">
        <div style="height:100%;background:var(--blue);width:0%;transition:width .3s;" id="hanos-progress"></div>
      </div>
    `;
  }

  try {
    const resp = await apiPost('/api/hanos/add-to-cart', {
      items: items.map(i => ({ orderCode: i.orderCode, quantity: i.quantity, unit: i.unit })),
      location: S.currentLoc,
    });

    const progEl = document.getElementById('hanos-progress');
    if (progEl) progEl.style.width = '100%';

    setTimeout(() => {
      closeModal();
      if (resp.failed === 0) {
        toast(`All ${resp.ok} items added to Hanos cart`);
        markHanosResults(resp.results, source);
      } else {
        toastError(`${resp.ok} added, ${resp.failed} failed`);
        markHanosResults(resp.results, source);
      }
    }, 400);
  } catch (e: unknown) {
    closeModal();
    toastError('Hanos error: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

/** Mark rows as succeeded/failed after Hanos add-to-cart */
function markHanosResults(results: HanosResult[], source: string) {
  if (!results || !results.length) return;
  const dataAttr = source === 'batches' ? 'data-stock-key' : 'data-combined-key';
  for (const r of results) {
    // Find the row by order code
    const rows = document.querySelectorAll(`.ing-table tr[${dataAttr}]`);
    for (const row of rows) {
      const dbName = (row as HTMLElement).dataset.dbname || (row as HTMLElement).dataset.stockKey || (row as HTMLElement).dataset.combinedKey || '';
      const db = lookupIngredient(dbName);
      if (db && db.orderCode === r.orderCode) {
        const el = row as HTMLElement;
        if (r.success) {
          el.classList.add('hanos-sent');
          el.classList.remove('hanos-failed');
        } else {
          el.classList.add('hanos-failed');
          el.classList.remove('hanos-sent');
          // Add failure indicator to the to-order cell
          const toOrderCell = el.querySelector('.to-order-positive');
          if (toOrderCell && !el.querySelector('.hanos-fail-badge')) {
            toOrderCell.insertAdjacentHTML('afterend', ` <span class="hanos-fail-badge" title="${esc(r.error || 'Failed')}">⚠ failed</span>`);
          }
        }
        break;
      }
    }
  }
}

// ── Grams-per-piece for stuk items ──────────────────────

export async function saveGramsPerPiece(ingredientId: string, combinedKey: string, value: string) {
  const grams = parseInt(value, 10);
  if (!grams || grams <= 0) return;

  const dbIng = ingredientDb().find(i => i.id === ingredientId);
  if (!dbIng) return;

  // Update locally
  dbIng.orderUnitSize = grams;

  // Save to server
  try {
    await apiPost(`/api/ingredients/${ingredientId}`, { ...dbIng, orderUnitSize: grams });
    toast(`Saved ${grams}g per piece for ${dbIng.name}`);
    renderOrders();
  } catch (e: unknown) {
    toastError('Failed to save: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Existing helpers ──────────────────────────────────────

export function toggleOrderSection(key: 'batches' | 'standard') { S.orderToggles[key] = !S.orderToggles[key]; renderOrders(); }

// Persist stock to the ingredient DB so it survives reloads and syncs across tabs
export let _stockSaveTimeout: ReturnType<typeof setTimeout> | null = null;
export function persistIngredientStock(ingredientName: string, amount: number) {
  const db = lookupIngredient(ingredientName);
  if (!db || !db.id) return;
  const loc = S.currentLoc || 'west';
  const amountNum = amount || 0;

  // Update in S.ingredientDb immediately
  if (!db.stock) db.stock = {};
  db.stock[loc] = { amount: amountNum, date: new Date().toISOString().slice(0, 10) };

  // Update in ingredientDbFull too (if loaded)
  if (typeof ingredientDbFull !== 'undefined') {
    const full = ingredientDbFull.find(i => i.id === db.id);
    if (full) {
      if (!full.stock) full.stock = {};
      full.stock[loc] = { amount: amountNum, date: new Date().toISOString().slice(0, 10) };
    }
  }

  // Debounced save to backend
  clearTimeout(_stockSaveTimeout);
  _stockSaveTimeout = setTimeout(() => {
    fetch('/api/ingredients/stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ingredientId: db.id, location: loc, amount: amountNum }),
    }).catch(e => console.error('Stock save failed:', e));
  }, 600);
}

// Shared inline stock update — input is in order units, convert to base for storage
export function _updateStockInline(storageObj: Record<string, number>, key: string, val: string | null, rowSelector: string, neededAttr: string) {
  if (val === '' || val === null) {
    delete storageObj[key];
  } else {
    storageObj[key] = parseFloat(val) || 0;
  }

  const db = lookupIngredient(key);
  // Persist to DB in base units
  if (db) {
    const baseAmount = (db.orderUnitSize > 0) ? (parseFloat(val) || 0) * db.orderUnitSize : (parseFloat(val) || 0);
    persistIngredientStock(db.name, baseAmount);
  }

  const row = document.querySelector(rowSelector);
  if (!row) return;
  const neededBase = parseFloat(row.dataset[neededAttr]) || 0;
  const stockUnits = parseFloat(val) || 0;
  const stockBase = (db && db.orderUnitSize > 0) ? stockUnits * db.orderUnitSize : stockUnits;
  const toOrderBase = Math.max(0, neededBase - stockBase);
  const hasOrderUnit = db && db.orderUnitSize > 0;
  const orderUnitLabel = db && db.orderUnit ? db.orderUnit : '';
  const unitSuffix = hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, db ? db.unit : 'g'); return f.unit; })();

  const toOrderEl = row.querySelector('.to-order-cell');
  if (toOrderEl) {
    if (val === '' || val === null || val === undefined) {
      toOrderEl.innerHTML = '<span style="color:var(--text2);font-size:11px;">enter stock \u2192</span>';
    } else if (toOrderBase <= 0) {
      toOrderEl.innerHTML = '<span class="to-order-zero">\u2713 enough</span>';
    } else {
      const calc = hasOrderUnit ? calcOrderUnits(toOrderBase, db) : null;
      if (calc) {
        toOrderEl.innerHTML = `<span class="to-order-positive">${calc.units}x ${esc(unitSuffix)}</span>`;
      } else {
        const f = formatAmount(toOrderBase, db ? db.unit : 'g');
        toOrderEl.innerHTML = `<span class="to-order-positive">${f.amount} ${esc(f.unit)}</span>`;
      }
    }
  }
}

export function updateCombinedOrderStock(key: string, val: string) {
  _updateStockInline(combinedOrderStock, key, val, `[data-combined-key="${key}"]`, 'needed');
}

export function updateOrderStock(key: string, val: string) {
  _updateStockInline(orderInventory, key, val, `[data-stock-key="${key}"]`, 'needed');
}

export async function refreshAllRecipes() {
  const curLoc = S.currentLoc;
  ensureBatchTogglesInitialized(curLoc);
  const dishes = S.batches.filter(d => d.location === curLoc && !isBatchCooked(d) && !!batchIngredientToggles[d.id] && d.recipeSheetId);
  if (!dishes.length) { toast('No batches with recipe sheets to refresh'); return; }
  toast('Refreshing ' + dishes.length + ' recipe(s)...');
  let ok = 0;
  for (const d of dishes) {
    try {
      const recipe = await apiGet(`/api/recipe?sheetId=${d.recipeSheetId}`);
      if (recipe.allergens) d.allergens = recipe.allergens;
      if (recipe.recipeVolume) d.recipeVolume = recipe.recipeVolume;
      if (recipe.serving) d.serving = recipe.serving;
      if (recipe.ingredients) d.recipeIngredients = recipe.ingredients;
      ok++;
    } catch (e: unknown) { console.error('Failed to refresh ' + d.name, e); }
  }
  scheduleSave();
  renderOrders();
  toast(ok + ' recipe(s) refreshed');
}

// ── Stocktake Mode ────────────────────────────────────────

export let stocktakeActive = false;
export let stocktakeArea = null;       // currently displayed storage area name
export let stocktakeValues = {};       // { ingredientId: orderUnitsValue } — accumulated across areas
export let stocktakeSavedAreas = [];   // area names that have been saved already

/** Build combined order data (shared between render and stocktake) */
export function buildCombinedOrderData() {
  const combined: Record<string, CombinedOrderEntry> = {};
  const curLoc = S.currentLoc;

  // Use the same per-batch toggles as the Batch Ingredients tab
  ensureBatchTogglesInitialized(curLoc);
  const orderedDishes = S.batches.filter(d =>
    d.location === curLoc && !isBatchCooked(d) && !!batchIngredientToggles[d.id]
  );

  function addToMap(name: string, amtGrams: number, isStandard: boolean, dishName: string | null) {
    const key = name.toLowerCase().trim();
    if (!combined[key]) combined[key] = { name, totalGrams: 0, standardGrams: 0, dishGrams: 0, dishes: [] };
    combined[key].totalGrams += amtGrams;
    if (isStandard) combined[key].standardGrams += amtGrams;
    else if (dishName) {
      combined[key].dishGrams += amtGrams;
      if (!combined[key].dishes.includes(dishName)) combined[key].dishes.push(dishName);
    }
  }

  if (combinedIncludeDishes) {
    orderedDishes.forEach(dish => {
      calcIngredientsFromRecipe(dish).forEach(ing => {
        addToMap(ing.name, toBaseUnit(ing.amount, ing.unit), false, dish.name);
      });
    });
  }

  getStandardInventoryItems(curLoc).forEach(ing => {
    const target = ing.targetStock[curLoc] || 0;
    const currentStock = (ing.stock && ing.stock[curLoc]) ? (ing.stock[curLoc].amount || 0) : 0;
    const deficit = Math.max(0, target - currentStock);
    if (deficit <= 0) return;
    addToMap(ing.name, deficit, true, null);
  });

  return Object.values(combined).map(ing => {
    const db = lookupIngredient(ing.name);
    return { ...ing, db };
  });
}

/** Get all ingredients for a given storage area at the current location */
export function getIngredientsForArea(areaName: string) {
  const loc = S.currentLoc;
  const combinedData = buildCombinedOrderData();
  const combinedByKey: Record<string, (typeof combinedData)[number]> = {};
  combinedData.forEach(c => { combinedByKey[c.name.toLowerCase().trim()] = c; });

  // Get ingredients that are needed (standard inventory or batch) and stored in this area
  return ingredientDb().filter(ing => {
    if (!ing.storageLocations) return false;
    const sl = ing.storageLocations[loc];
    if (!sl) return false;
    const slCat = typeof sl === 'string' ? sl : sl.category;
    if (slCat !== areaName) return false;
    // Only include if this item is in the combined order (has demand)
    const key = ing.name.toLowerCase().trim();
    return !!combinedByKey[key];
  }).map(ing => {
    const key = ing.name.toLowerCase().trim();
    const combined = combinedByKey[key];
    const hasOrderUnit = ing.orderUnitSize > 0;
    const stockBase = (ing.stock && ing.stock[loc]) ? (ing.stock[loc].amount || 0) : 0;
    const stockUnits = hasOrderUnit ? Math.round(stockBase / ing.orderUnitSize * 10) / 10 : stockBase;
    const neededBase = combined ? combined.totalGrams : 0;
    const standardBase = combined ? combined.standardGrams : 0;
    const dishBase = combined ? combined.dishGrams : 0;
    const neededCalc = hasOrderUnit && neededBase > 0 ? calcOrderUnits(neededBase, ing) : null;
    const slVal = ing.storageLocations[loc];
    const spot = (slVal && typeof slVal !== 'string' && slVal.location) || '';
    return {
      ...ing,
      spot,
      stockBase,
      stockUnits,
      neededBase,
      standardBase,
      dishBase,
      neededCalc,
      hasOrderUnit,
    };
  }).sort((a: { spot: string; name: string }, b: { spot: string; name: string }) => {
    // Sort by spot first, then name
    if (a.spot !== b.spot) return a.spot.localeCompare(b.spot);
    return a.name.localeCompare(b.name);
  });
}

/** Start stocktake — show area picker */
export function startStocktake() {
  trackEvent('stocktake_start');
  stocktakeActive = true;
  stocktakeArea = null;
  stocktakeValues = {};
  stocktakeSavedAreas = [];
  renderStocktakeAreaPicker();
}

export function renderStocktakeAreaPicker() {
  const loc = S.currentLoc;
  const areas = getStorageConfigForLoc(loc);
  const container = document.getElementById('screen-orders');

  let html = `<div style="padding:20px;max-width:600px;margin:0 auto;">
    <h2 style="margin:0 0 8px;">📋 Stocktake</h2>
    <p style="color:var(--text2);margin:0 0 20px;">${esc(loc === 'west' ? 'Sering West' : 'Sering Centraal')} — Select a storage area to count</p>
    <div style="display:grid;gap:12px;">`;

  areas.forEach(area => {
    const items = getIngredientsForArea(area.name);
    const isSaved = stocktakeSavedAreas.includes(area.name);
    const statusIcon = isSaved ? '✅' : '';
    html += `<button class="btn" style="display:flex;align-items:center;gap:12px;padding:16px 20px;font-size:16px;border-left:5px solid ${area.color || '#999'};text-align:left;background:${isSaved ? 'var(--bg2)' : 'var(--bg1)'};" onclick="enterStocktakeArea('${esc(area.name)}')">
      <span style="flex:1;">
        <span style="font-weight:600;">${statusIcon} ${esc(area.name)}</span>
        <span style="font-size:13px;color:var(--text2);margin-left:8px;">${items.length} items</span>
      </span>
      <span style="font-size:20px;">→</span>
    </button>`;
  });

  html += `</div>
    <div style="margin-top:24px;display:flex;gap:12px;">
      <button class="btn btn-sm" onclick="exitStocktake()">← Back to orders</button>
      ${stocktakeSavedAreas.length ? `<button class="btn btn-sm" style="background:var(--green);color:white;" onclick="exitStocktake()">Done</button>` : ''}
    </div>
  </div>`;

  container.innerHTML = html;
}

export function enterStocktakeArea(areaName: string) {
  stocktakeArea = areaName;
  renderStocktakeArea();
}

export function renderStocktakeArea() {
  const loc = S.currentLoc;
  const items = getIngredientsForArea(stocktakeArea);
  const areaConfig = getStorageConfigForLoc(loc).find(a => a.name === stocktakeArea);
  const areaColor = areaConfig ? areaConfig.color : '#999';
  const container = document.getElementById('screen-orders');

  // Group by spot
  const bySpot: Record<string, typeof items> = {};
  items.forEach(ing => {
    const spot = ing.spot || 'No spot assigned';
    if (!bySpot[spot]) bySpot[spot] = [];
    bySpot[spot].push(ing);
  });

  let html = `<div style="padding:16px;max-width:700px;margin:0 auto;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;border-left:5px solid ${areaColor};padding-left:12px;">
      <div>
        <h2 style="margin:0;font-size:20px;">📋 ${esc(stocktakeArea)}</h2>
        <p style="color:var(--text2);margin:2px 0 0;font-size:13px;">${esc(loc === 'west' ? 'Sering West' : 'Sering Centraal')} — ${items.length} items</p>
      </div>
    </div>`;

  if (!items.length) {
    html += `<div class="empty">No items needed from this area.</div>`;
  } else {
    // Column headers + legend
    html += `<div class="stocktake-header" style="display:flex;align-items:center;padding:4px;margin-bottom:8px;font-size:11px;color:var(--text2);border-bottom:1px solid var(--border);">
      <div style="flex:1;">Item &nbsp; <span style="color:var(--green);">●</span> standard &nbsp; <span style="color:var(--purple, #7c3aed);">●</span> batches</div>
      <div style="width:55px;text-align:center;">Stock</div>
      <div style="width:65px;"></div>
      <div style="width:90px;text-align:right;">To order</div>
    </div>`;

    Object.keys(bySpot).forEach(spot => {
      const spotItems = bySpot[spot];
      html += `<div style="margin-bottom:16px;">
        <div style="font-weight:600;font-size:13px;padding:4px 0;border-bottom:2px solid ${areaColor};margin-bottom:4px;color:var(--text1);">📍 ${esc(spot)}</div>`;

      spotItems.forEach(ing => {
        const orderUnitLabel = ing.orderUnit || '';
        const unitSuffix = ing.hasOrderUnit ? (orderUnitLabel || 'units') : (() => { const f = formatAmount(0, ing.unit); return f.unit; })();

        // Breakdown lines under the name
        let breakdownLines = '';
        if (ing.standardBase > 0) {
          const sc = ing.hasOrderUnit ? calcOrderUnits(ing.standardBase, ing) : null;
          const label = sc ? `${sc.units}x ${esc(unitSuffix)}` : (() => { const f = formatAmount(ing.standardBase, ing.unit); return `${f.amount} ${f.unit}`; })();
          breakdownLines += `<div style="font-size:11px;color:var(--green);font-weight:500;">● ${label} standard</div>`;
        }
        if (ing.dishBase > 0) {
          const dc = ing.hasOrderUnit ? calcOrderUnits(ing.dishBase, ing) : null;
          const label = dc ? `${dc.units}x ${esc(unitSuffix)}` : (() => { const f = formatAmount(ing.dishBase, ing.unit); return `${f.amount} ${f.unit}`; })();
          breakdownLines += `<div style="font-size:11px;color:var(--purple, #7c3aed);font-weight:500;">● ${label} batches</div>`;
        }

        // Pre-fill only from in-session stocktake values (not DB stock).
        // Empty = "not counted" (skipped on save). 0 = "counted, nothing on stock".
        const prefill = stocktakeValues[ing.id] !== undefined ? stocktakeValues[ing.id] : '';

        html += `<div class="stocktake-row" style="display:flex;align-items:center;padding:6px 4px;border-bottom:1px solid var(--border);">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:500;">${esc(ing.name)}</div>
            ${breakdownLines}
          </div>
          <div style="width:55px;text-align:center;flex-shrink:0;">
            <input class="order-stock-input stocktake-input" type="number" min="0" step="0.5" value="${prefill !== '' ? prefill : ''}" placeholder="\u2014" style="width:50px;font-size:15px;text-align:center;" data-ing-id="${esc(ing.id)}" oninput="updateStocktakeToOrder(this)" />
          </div>
          <div style="width:65px;font-size:10px;color:var(--text2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(unitSuffix)}</div>
          <div class="stocktake-to-order" style="width:90px;text-align:right;font-size:12px;" data-needed-base="${ing.neededBase}" data-order-unit-size="${ing.orderUnitSize || 0}" data-unit="${esc(ing.unit || 'g')}" data-order-unit="${esc(ing.orderUnit || '')}">
            ${_calcStocktakeToOrder(ing, prefill)}
          </div>
        </div>`;
      });

      html += `</div></div>`;
    });
  }

  html += `<div class="stocktake-save-bar" style="position:sticky;bottom:0;background:var(--bg1);padding:16px 0;border-top:2px solid var(--border);display:flex;gap:12px;flex-wrap:wrap;">
    <button class="btn" style="background:var(--green);color:white;flex:1;padding:12px;font-size:15px;" onclick="saveStocktakeArea(true)">Save & next area →</button>
    <button class="btn" style="background:var(--orange, #e67e22);color:white;flex:1;padding:12px;font-size:15px;" onclick="saveStocktakeArea(false)">Save & stop stocktake</button>
  </div>
  <div style="height:80px;"></div>
  </div>`;

  container.innerHTML = html;
  // UX: prevent scroll-wheel + Enter-to-next on stocktake inputs
  setupOrderInputUX(container);
  // Focus first empty input
  const firstEmpty = container.querySelector('.stocktake-input[value=""]') as HTMLInputElement;
  if (firstEmpty) firstEmpty.focus();
}

export function _calcStocktakeToOrder(ing: { hasOrderUnit: boolean; orderUnitSize: number; neededBase: number; unit: string; orderUnit: string }, stockUnitsVal: string | number | undefined | null) {
  // Empty/undefined = not counted → show dash
  if (stockUnitsVal === '' || stockUnitsVal === undefined || stockUnitsVal === null) {
    return '<span style="color:var(--text2);font-style:italic;">not counted</span>';
  }
  const stockUnits = parseFloat(stockUnitsVal) || 0;
  const stockBase = ing.hasOrderUnit ? stockUnits * ing.orderUnitSize : stockUnits;
  const toOrderBase = Math.max(0, ing.neededBase - stockBase);
  if (ing.neededBase <= 0) return '<span style="color:var(--text2);">—</span>';
  if (toOrderBase <= 0) return '<span class="to-order-zero">\u2713</span>';
  const unitSuffix = ing.hasOrderUnit ? (ing.orderUnit || 'units') : (() => { const f = formatAmount(0, ing.unit); return f.unit; })();
  if (ing.hasOrderUnit) {
    const calc = calcOrderUnits(toOrderBase, ing);
    return calc ? `<span class="to-order-positive">${calc.units}x ${esc(unitSuffix)}</span>` : `<span class="to-order-positive">${esc(unitSuffix)}</span>`;
  }
  const f = formatAmount(toOrderBase, ing.unit);
  return `<span class="to-order-positive">${f.amount} ${f.unit}</span>`;
}

export function updateStocktakeToOrder(input: HTMLInputElement) {
  const row = input.closest('.stocktake-row');
  const toOrderCell = row.querySelector('.stocktake-to-order');
  if (!toOrderCell) return;
  // Record value into module-level stocktakeValues (inline oninput can't access module scope)
  const ingId = input.dataset.ingId;
  if (ingId) stocktakeValues[ingId] = input.value === '' ? undefined : parseFloat(input.value);
  // Empty input = not counted
  if (input.value === '') {
    toOrderCell.innerHTML = '<span style="color:var(--text2);font-style:italic;">not counted</span>';
    return;
  }
  const neededBase = parseFloat(toOrderCell.dataset.neededBase) || 0;
  const orderUnitSize = parseFloat(toOrderCell.dataset.orderUnitSize) || 0;
  const unit = toOrderCell.dataset.unit || 'g';
  const orderUnit = toOrderCell.dataset.orderUnit || '';
  const hasOrderUnit = orderUnitSize > 0;
  const stockUnits = parseFloat(input.value) || 0;
  const stockBase = hasOrderUnit ? stockUnits * orderUnitSize : stockUnits;
  const toOrderBase = Math.max(0, neededBase - stockBase);
  const unitSuffix = hasOrderUnit ? (orderUnit || 'units') : (() => { const f = formatAmount(0, unit); return f.unit; })();

  if (neededBase <= 0) { toOrderCell.innerHTML = '<span style="color:var(--text2);">—</span>'; return; }
  if (toOrderBase <= 0) { toOrderCell.innerHTML = '<span class="to-order-zero">\u2713</span>'; return; }
  if (hasOrderUnit) {
    const calc = calcOrderUnits(toOrderBase, { orderUnitSize, unit, orderUnit });
    toOrderCell.innerHTML = calc ? `<span class="to-order-positive">${calc.units}x ${esc(unitSuffix)}</span>` : '';
  } else {
    const f = formatAmount(toOrderBase, unit);
    toOrderCell.innerHTML = `<span class="to-order-positive">${f.amount} ${f.unit}</span>`;
  }
}

/** Save stocktake for current area — persist stock to DB */
export async function saveStocktakeArea(goToNext: boolean) {
  const loc = S.currentLoc;
  const items = getIngredientsForArea(stocktakeArea);
  let saved = 0;

  // Collect values from DOM inputs (don't rely solely on oninput handler — unreliable on mobile)
  const container = document.getElementById('screen-orders');
  if (container) {
    container.querySelectorAll('.stocktake-input').forEach((input: HTMLInputElement) => {
      const ingId = input.dataset.ingId;
      if (ingId) stocktakeValues[ingId] = input.value === '' ? undefined : parseFloat(input.value);
    });
  }

  // Batch save all items that have stocktake values
  const updates = [];
  items.forEach(ing => {
    const val = stocktakeValues[ing.id];
    if (val === undefined) return; // not touched — skip
    const baseAmount = ing.orderUnitSize > 0 ? val * ing.orderUnitSize : val;
    // Update local state
    if (!ing.stock) ing.stock = {};
    ing.stock[loc] = { amount: baseAmount, date: new Date().toISOString().slice(0, 10) };
    updates.push({ ingredientId: ing.id, location: loc, amount: baseAmount });
    saved++;
  });

  if (updates.length) {
    try {
      await apiPost('/api/ingredients/stock/bulk', updates);
    } catch (e: unknown) {
      toastError('Failed to save stock: ' + (e instanceof Error ? e.message : 'Unknown error'));
      return;
    }
    // Also update ingredientDb in memory
    updates.forEach(u => {
      const dbIng = S.ingredientDb.find(i => i.id === u.ingredientId);
      if (dbIng) {
        if (!dbIng.stock) dbIng.stock = {};
        dbIng.stock[u.location] = { amount: u.amount, date: new Date().toISOString().slice(0, 10) };
      }
    });
  }

  stocktakeSavedAreas.push(stocktakeArea);
  toast(`${esc(stocktakeArea)}: ${saved} items saved`);

  if (goToNext) {
    renderStocktakeAreaPicker();
  } else {
    exitStocktake();
  }
}

export function exitStocktake() {
  stocktakeActive = false;
  stocktakeArea = null;
  stocktakeValues = {};
  stocktakeSavedAreas = [];
  renderOrders();
}

