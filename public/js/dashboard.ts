import type { Batch, Location, Meal, DishType, Supply } from '@shared/types';
import { S, DAYS, MEALS, LOCATIONS, ALLERGENS, ACCOMPANIMENTS } from './state';

/** Batch with optional dashboard-only starch selection (not persisted in shared type) */
type DashBatch = Batch & { starch?: string | null };
import { scheduleSave, toast, toastError, loadPrepChecklist, schedulePrepSave, todayIso, loadData, connectLiveSync, newId, formatRelativeTime } from './utils';
import { rebuildPlanner, getAmsterdamNow, dateToDayName, dateToIso, isServicePast, calcRequired, calcRequiredBreakdown, calcTotalGuests, calcIngredientsFromRecipe, storageBadge, storageBadgeClass, typeBadge, typeBadgeClass, TYPES, isBatchCooked, getGuests, getEffectiveGuests, getToday, dateToStr, chipClass, getStockAt, getPendingFromShipments } from './core';
import { getVisibleDays, getMondayKeyForDate, localDateStr, renderDayNav, AGG_MEALS, buildFlowDistribution } from './predictions';
import { calcRequiredForLoc, confirmCooked, inlineAddAllergenStart, inlineRemoveAllergen } from './dishes';
import { esc } from './modal';
import { registerRenderer, setOnScreenChange, setBackgroundRefresh, showScreen, getScreenFromHash } from './navigate';
// Stocktake helpers used by the dashboard chip — kept distinct from the
// individual screen render fns (those self-register via navigate.ts now).
import { startStocktake, renderStocktakeAreaPicker, enterStocktakeArea, renderStocktakeArea, saveStocktakeArea, exitStocktake, getIngredientsForArea } from './orders';
import { saveStocktakeWithToast } from './stocktake';
import { trackScreenView } from './telemetry';
import { showModal, closeModal } from './modal';
import { getStorageConfigForLoc } from './state';
import { locName } from '@shared/location';
import { renderTransportCard, renderCentraalArrivalBlock } from './transport-card';
import { openBatchRecipe } from './recipe-editor';
import { computeSupplyDemand, supplyPricePerGuest } from '@shared/supply-demand';

// SCREENS
// ═══════════════════════════════════════════════════════════════════
// showScreen and getScreenFromHash now live in navigate.ts. Each screen
// module self-registers via registerRenderer() at import time. Imported
// above (not a bare `export ... from`) so the names are also in this
// module's local scope — navTo() below calls showScreen() directly — and
// re-exported here so consumers that already import { showScreen } from
// './dashboard' don't break.
export { showScreen, getScreenFromHash };

// Wire telemetry into showScreen via the navigate.ts hook — keeps navigate.ts
// free of any screen-specific imports while still preserving the original
// trackScreenView call on every navigation.
setOnScreenChange(trackScreenView);

// ── CHOPPABLE INGREDIENT LOGIC ───────────────────────────────
export const CHOPPABLE_CATEGORIES = [
  'vegetables & fruit',
  'herbs & spices',
  'vegetables', 'fruits', 'mushrooms', 'herbs', 'beans and legumes',
];

export const PANTRY_KEYWORDS = [
  'oil','olie','salt','zout','sugar','suiker','pepper','peper',
  'vinegar','azijn','soy sauce','sojasaus','ketjap','tamari',
  'flour','meel','bloem','butter','boter','margarine',
  'cream','room','slagroom','milk','melk',
  'stock','bouillon','broth',
  'powder','poeder','cumin','komijn','cinnamon','kaneel',
  'turmeric','kurkuma','paprikapoeder','chili powder','chilipoeder',
  'nutmeg','nootmuskaat','cloves','kruidnagel',
  'bay leaf','laurier',
  'coconut milk','kokosmelk','coconut cream','kokosroom',
  'tomato paste','tomatenpuree','tomato puree',
  'mustard','mosterd','honey','honing','maple','ahorn',
  'rice','rijst','pasta','noodles','noedels','couscous',
  'sambal','sriracha','hot sauce','tabasco',
  'water','cornstarch','maizena','agar','tapioca',
  'yeast','gist','baking powder','bakpoeder','baking soda',
  'breadcrumbs','paneermeel','panko',
  'vanilla','vanille','extract','essence',
  'miso','nutritional yeast','gistgvlokken',
  'seaweed','nori','wakame','kombu',
  'tahini','peanut butter','pindakaas',
  'lemon juice','citroensap','lime juice','limoensap',
  'paste','puree','purée','mashed',
  'dried','gedroogd','gerist','gemalen','gehakt',
  'cashew','almond','amandel','walnut','walnoot','hazelno','pecannot','pistachio','pinda','macadamia',
  'seed','zaad','zaden','pitten',
  'rozijn','raisin','vijg','dadel','pruim','moerbeien',
  'noten','nuts','nibs','flakes','vlokken',
  'agar','xanthan','xanthana','lecithin','inulin','isomalt','pectin','gelespessa',
  'msg','maggi','liquid smoke',
  // Proteins (not choppable)
  'tofu','tempeh','seitan','tvp','soy protein','soja eiwit',
  // Canned/preserved
  'canned','blik','ingeblikt','conserven',
  // Dry legumes/grains (not choppable)
  'lentil','linzen','chickpea','kikkererwt','bean','boon','bonen',
  'beluga','split pea','kapucijner',
  // Frozen items (not choppable prep)
  'frozen','bevroren','diepvries',
  // Spice blends
  'garam masala','curry powder','kerrie','five spice','ras el hanout',
  'za\'atar','zaatar','berbere','harissa','jerk',
];

export let _ingredientCategoryCache: Map<string, string> | null = null;
export function invalidateCategoryCache() { _ingredientCategoryCache = null; }
export function getIngredientCategoryCache() {
  if (_ingredientCategoryCache && _ingredientCategoryCache.size > 0) return _ingredientCategoryCache;
  _ingredientCategoryCache = new Map();
  (S.ingredientDb || []).forEach(ing => {
    const cat = (ing.category || '').toLowerCase().trim();
    if (!cat) return;
    if (ing.name) _ingredientCategoryCache!.set(ing.name.toLowerCase().trim(), cat);
    if (ing.supplierName) _ingredientCategoryCache!.set(ing.supplierName.toLowerCase().trim(), cat);
  });
  return _ingredientCategoryCache;
}

export function isChoppableIngredient(name: string) {
  const lower = name.toLowerCase().trim();
  if (PANTRY_KEYWORDS.some(kw => lower.includes(kw))) return false;
  const cache = getIngredientCategoryCache();
  const exact = cache.get(lower);
  if (exact) return CHOPPABLE_CATEGORIES.includes(exact);
  const wordBoundary = (haystack: string, needle: string) => {
    const i = haystack.indexOf(needle);
    if (i === -1) return false;
    const before = i === 0 || /\W/.test(haystack[i - 1]);
    const after = i + needle.length >= haystack.length || /\W/.test(haystack[i + needle.length]);
    return before && after;
  };
  const matchedCats: string[] = [];
  for (const [dbName, cat] of cache) {
    if (dbName === lower) continue;
    if (wordBoundary(dbName, lower) || wordBoundary(lower, dbName)) {
      matchedCats.push(cat);
    }
  }
  if (matchedCats.length > 0) {
    return matchedCats.some(cat => CHOPPABLE_CATEGORIES.includes(cat));
  }
  // Not found in DB and not a pantry keyword — exclude by default
  return false;
}

// ── HELPERS ──────────────────────────────────────────────────

/**
 * Whether `dish` is "at" `loc` for cook-planning purposes. In the unified-
 * batch model "where is the batch" depends on intent:
 *   - For uncooked batches (inventory empty): the cook location is
 *     `inventory[0].loc` (sticky from first confirmCooked) — defaults to
 *     'west' for never-cooked placeholders.
 *   - For cooked batches with stock: the loc is wherever the stock sits.
 *
 * This helper handles both: a batch is at `loc` if its primary cook loc is
 * `loc` OR it has any inventory at `loc`. Used by `getCookDateDishes` to
 * find batches scheduled to cook at a kitchen on a given date.
 */
function batchPrimaryLoc(b: Batch): Location {
  return (b.inventory && b.inventory.length > 0 ? b.inventory[0].loc : 'west');
}

export function isDishAtLocation(dish: Batch, loc: Location) {
  return batchPrimaryLoc(dish) === loc || getStockAt(dish, loc) > 0;
}

export function getCookDateDishes(loc: Location, date: Date) {
  const dateStr = dateToStr(date);
  return S.batches.filter(d =>
    d.cookDate === dateStr &&
    !isBatchCooked(d) &&
    isDishAtLocation(d, loc)
  );
}

export function getMenuDishes(loc: Location, dateStr: string) {
  const seen = new Set<string>();
  const dishes: Batch[] = [];
  MEALS.forEach(meal => {
    const k = `${loc}-${dateStr}-${meal}`;
    (S.planner[k] || []).forEach(d => {
      if (!seen.has(d.id)) { seen.add(d.id); dishes.push(d); }
    });
  });
  return dishes;
}

export function getMenuDishesForMeal(loc: Location, dateStr: string, meal: Meal) {
  const k = `${loc}-${dateStr}-${meal}`;
  return S.planner[k] || [];
}

export function calcLitersForService(dish: Batch, loc: Location, dateStr: string, meal: Meal) {
  const k = `${loc}-${dateStr}-${meal}`;
  const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
  const count = Math.max(peers.length, 1);
  const g = getEffectiveGuests(loc, dateStr, meal);
  return Math.round((g / count) * ((dish.serving || 280) / 1000) * 10) / 10;
}

interface VegIngredient { name: string; amount: number; unit: string }

export function getVegIngredients(dishes: Batch[]) {
  const combined: Record<string, VegIngredient> = {};
  dishes.forEach(dish => {
    const ings = calcIngredientsFromRecipe(dish);
    if (!ings || ings.length === 0) return;
    ings.filter(i => isChoppableIngredient(i.name)).forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      if (!combined[key]) combined[key] = { name: ing.name, amount: 0, unit: ing.unit };
      combined[key].amount += ing.amount;
    });
  });
  return Object.values(combined).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Starch picker ────────────────────────────────────────────

export function setDishStarch(dishId: string, starch: string) {
  const d = S.batches.find(x => x.id === dishId) as DashBatch | undefined;
  if (!d) return;
  d.starch = (d.starch === starch) ? null : starch;
  scheduleSave();
  renderDashboardContent();
}

export function starchSummaryHtml(dishes: DashBatch[], gc: number) {
  const mains = dishes.filter(d => d.type === 'Main course' && d.starch);
  if (!mains.length) return '';
  const totals: Record<string, number> = {};
  mains.forEach(d => {
    const peers = dishes.filter(p => p.type === 'Main course');
    const guestsForDish = Math.round(gc / Math.max(peers.length, 1));
    const kg = parseFloat((Math.round(guestsForDish * 1.2) * 80 / 1000).toFixed(1));
    totals[d.starch!] = (totals[d.starch!] || 0) + kg;
  });
  const parts = Object.entries(totals).map(([name, kg]) =>
    `<span class="dash-starch-summary-item">${name === 'Rice' ? '🍚' : '🍝'} Cook <strong>${kg} kg</strong> ${name}</span>`
  );
  return `<div class="dash-starch-meal-summary">${parts.join('<span class="dash-starch-sep">+</span>')}</div>`;
}

// ── MEAL TOGGLE ──────────────────────────────────────────────

export function setDashMeal(meal: Meal) {
  S.dashMeal = meal;
  renderDashboardContent();
}

// Auto-detect meal based on time of day
function autoDetectMeal(): Meal {
  const hour = getAmsterdamNow().getHours();
  return hour < 15 ? 'lunch' : 'dinner';
}

// ── DISH CHIP COMPONENT ──────────────────────────────────────

const _expandedChips = new Set<string>();

export function toggleDashChipExpand(dishId: string) {
  if (_expandedChips.has(dishId)) _expandedChips.delete(dishId);
  else _expandedChips.add(dishId);
  renderDashboardContent();
}

interface ChipContext {
  meal?: Meal;
  dateStr?: string;
  liters?: number;
  note?: string;
  showAllergens?: boolean;
  showStarch?: boolean;
  showRecipe?: boolean;
  showStock?: boolean;
  checkable?: boolean;
  checked?: boolean;
  toggleFn?: string;
}

const TYPE_ICONS: Record<string, string> = { 'Soup': '🥣', 'Main course': '🍛', 'Dessert': '🍨' };

function renderGroupedByType(batches: Batch[], chipFn: (b: Batch) => string): string {
  const typeOrder: Record<string, number> = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
  const sorted = [...batches].sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));
  let html = '';
  let lastType = '';
  sorted.forEach(b => {
    if (b.type !== lastType) {
      lastType = b.type;
      const icon = TYPE_ICONS[b.type] || '🍽️';
      html += `<div class="dash-section-hdr">${icon} ${b.type}</div>`;
    }
    html += chipFn(b);
  });
  return html;
}

function renderDashChip(dish: Batch, ctx: ChipContext): string {
  const d = dish as DashBatch;
  const loc = S.currentLoc;
  const expanded = _expandedChips.has(dish.id);
  const typeColors: Record<string, string> = { 'Soup': 'green', 'Main course': 'blue', 'Dessert': 'purple' };
  const col = typeColors[dish.type] || 'gray';

  // Compact row — clicking the row body always expands the chip; the checkbox
  // (cook chips only) is a separate click target that fires the cook action.
  let html = `<div class="dash-chip ${expanded ? 'expanded' : ''} ${ctx.checked ? 'checked' : ''}">
    <div class="dash-chip-row" onclick="toggleDashChipExpand('${esc(dish.id)}')">`;

  if (ctx.checkable) {
    const checkClick = ctx.toggleFn ? `event.stopPropagation();${ctx.toggleFn}('${esc(dish.id)}')` : '';
    html += `<div class="dash-prep-check" onclick="${checkClick}">${ctx.checked ? '✓' : ''}</div>`;
  }

  html += `<span class="dash-chip-dot" style="background:var(--${col})"></span>
    <span class="dash-chip-name">${esc(dish.name)}</span>`;

  // Inline allergens on the chip row
  if (ctx.showAllergens) {
    const allergens = [...(dish.allergens || []), ...(dish.extraAllergens || [])];
    if (allergens.length) {
      html += `<span class="dash-chip-allergens">${allergens.map(a => `<span class="dash-chip-ag">${esc(a)}</span>`).join('')}</span>`;
    }
  }

  if (ctx.note) {
    const noteClass = ctx.note === 'frozen' ? 'note-blue' : ctx.note.includes('cook') ? 'note-amber' : 'note-gray';
    html += `<span class="dash-chip-note ${noteClass}">${ctx.note === 'frozen' ? '❄️' : ''} ${esc(ctx.note)}</span>`;
  }

  if (ctx.liters !== undefined) {
    html += `<span class="dash-chip-liters">${ctx.liters} L</span>`;
  } else if (ctx.showStock && getStockAt(dish, loc) > 0) {
    // toFixed(1) prevents float-precision dribble like 76.40000000000002 L
    // (which happens after a cancel-shipment merges qty back into an entry
    // whose original cookDate matched — the addition is exact-ish but the
    // IEEE754 representation isn't, and getStockAt just sums entries
    // without rounding).
    html += `<span class="dash-chip-liters">${getStockAt(dish, loc).toFixed(1)} L</span>`;
  }

  html += `<span class="dash-chip-arrow">${expanded ? '▾' : '›'}</span>
    </div>`;

  // Expanded foldout
  if (expanded) {
    html += `<div class="dash-chip-expand" onclick="event.stopPropagation()">`;

    // Allergens
    const allergens = [...(dish.allergens || []), ...(dish.extraAllergens || [])];
    html += `<div class="dash-chip-detail-row">
      <span class="dash-chip-detail-label">Allergens</span>
      <div class="dash-allergen-row allergen-inline" id="ag-inline-${dish.id}">
        ${allergens.length ? allergens.map(a =>
          `<span class="allergen-pill" onclick="event.stopPropagation();inlineRemoveAllergen('${dish.id}','${esc(a)}')" title="Click to remove">${esc(a)}</span>`
        ).join('') : '<span class="dash-chip-empty">None</span>'}
        <button class="allergen-add-btn" onclick="event.stopPropagation();inlineAddAllergenStart('${dish.id}',event)" title="Add allergen">+</button>
      </div>
    </div>`;

    // Starch picker for mains
    if (dish.type === 'Main course') {
      html += `<div class="dash-chip-detail-row">
        <span class="dash-chip-detail-label">Starch</span>
        <div class="dash-starch-picker">
          <button class="dash-starch-opt${d.starch === 'Rice' ? ' selected' : ''}" onclick="setDishStarch('${esc(dish.id)}','Rice');event.stopPropagation()">🍚 Rice</button>
          <button class="dash-starch-opt${d.starch === 'Pasta' ? ' selected' : ''}" onclick="setDishStarch('${esc(dish.id)}','Pasta');event.stopPropagation()">🍝 Pasta</button>
        </div>
      </div>`;
    }

    // Stock + cook date
    const cooked = isBatchCooked(dish);
    html += `<div class="dash-chip-detail-row">
      <span class="dash-chip-detail-label">Stock</span>
      <span>${getStockAt(dish, loc).toFixed(1)} L ${cooked ? '<span class="dash-chip-badge-ok">cooked</span>' : '<span class="dash-chip-badge-warn">uncooked</span>'}</span>
    </div>`;
    if (dish.cookDate) {
      html += `<div class="dash-chip-detail-row">
        <span class="dash-chip-detail-label">Cook date</span>
        <span>${esc(dish.cookDate)}</span>
      </div>`;
    }

    // Recipe link — only v2 recipes remain; legacy v1 recipeSheetId path
    // was removed with the unified-batch migration.
    if (dish.recipeId) {
      html += `<div class="dash-chip-detail-row">
        <button class="dash-recipe-btn" onclick="event.stopPropagation();openRecipeDetail('${esc(dish.recipeId)}')">📄 View Recipe</button>
      </div>`;
    }

    // Per-service breakdown
    const breakdown = calcRequiredBreakdown(dish);
    if (breakdown.length > 0) {
      html += `<div class="dash-chip-detail-row">
        <span class="dash-chip-detail-label">Services</span>
        <div class="dash-chip-services">${breakdown.map(l => `<div class="dash-chip-svc-line">${l}</div>`).join('')}</div>
      </div>`;
    }

    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ── DASHBOARD RENDER ─────────────────────────────────────────

export function renderDashboard() {
  // showScreen used to call rebuildPlanner() before dispatching to the
  // dashboard renderer. Now lives in navigate.ts and is renderer-agnostic, so
  // each renderer that needs the planner state regenerates it itself.
  rebuildPlanner();
  S.dashMeal = autoDetectMeal();
  const loc = S.currentLoc;

  // Show a loading placeholder until loadPrepChecklist resolves. On slow
  // networks this can take 1s+ and the dashboard otherwise appears blank
  // (user feedback #429 — "u need loading animation when the dashboard
  // takes forever to load"). The pulse keyframes are defined in base.css.
  document.getElementById('screen-dashboard')!.innerHTML = `
    <div id="dash-content">
      <div style="padding:40px 20px;text-align:center;color:var(--text3);animation:pulse 1.2s ease-in-out infinite;">
        Loading dashboard…
      </div>
    </div>
  `;

  loadDayTodos();
  loadPrepChecklist(loc).then(() => { renderDashboardContent(); });
}

// ── Guest Flow Chart ─────────────────────────────────────────

export let _guestFlowMeal = 'lunch';

export function setGuestFlowMeal(meal: Meal) {
  _guestFlowMeal = meal;
}

export function gaussian(x: number, center: number, sigma: number) {
  return Math.exp(-0.5 * Math.pow((x - center) / sigma, 2));
}

export function buildGuestFlowData(totalGuests: number, meal: string, loc: string) {
  const today = getToday();
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = DAY_NAMES[today.getDay()];
  const dist = S.guestFlowDistribution;

  const SERVICE_WINDOWS = {
    lunch:  { start: 12 * 60, end: 14 * 60 },
    dinner: { start: 18 * 60, end: 21 * 60 },
  };
  const win = SERVICE_WINDOWS[meal as Meal];

  if (dist && dist[loc] && (dist[loc] as Record<string, Record<string, Record<string, number>>>)[meal] && (dist[loc] as Record<string, Record<string, Record<string, number>>>)[meal][dow]) {
    const buckets = (dist[loc] as Record<string, Record<string, Record<string, number>>>)[meal][dow];
    const entries = Object.entries(buckets)
      .map(([minStr, frac]) => ({ min: parseInt(minStr), frac: frac as number }))
      .filter(e => e.min >= win.start && e.min < win.end)
      .sort((a, b) => a.min - b.min);
    if (entries.length >= 3) {
      const fracSum = entries.reduce((s, e) => s + e.frac, 0);
      const scale = fracSum > 0 ? 1 / fracSum : 1;
      return entries.map(e => {
        const h = Math.floor(e.min / 60);
        const m = e.min % 60;
        return {
          time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
          guests: Math.round(e.frac * scale * totalGuests * 10) / 10
        };
      });
    }
  }

  const LUNCH = { start: 12 * 60, end: 14 * 60, peak: 12 * 60 + 35, sigma: 22 };
  const DINNER = { start: 18 * 60, end: 21 * 60, peak: 19 * 60 + 10, sigma: 30 };
  const cfg = meal === 'lunch' ? LUNCH : DINNER;

  const slots: Array<{ min: number; weight: number }> = [];
  let totalWeight = 0;
  for (let t = cfg.start; t < cfg.end; t += 5) {
    const w = gaussian(t, cfg.peak, cfg.sigma);
    slots.push({ min: t, weight: w });
    totalWeight += w;
  }

  return slots.map(s => {
    const h = Math.floor(s.min / 60);
    const m = s.min % 60;
    return {
      time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      guests: Math.round((s.weight / totalWeight) * totalGuests * 10) / 10
    };
  });
}

export function drawGuestFlowChart() {
  const canvas = document.getElementById('guest-flow-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement!.getBoundingClientRect();
  const w = rect.width;
  const h = 140;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const loc = S.currentLoc;
  const todayStr = dateToIso(getToday());
  const meal = S.dashMeal;
  const totalGuests = getGuests(loc, todayStr, meal);
  const data = buildGuestFlowData(totalGuests, meal, loc);

  // Follow the app's theme strictly (class-based, like the rest of the UI) so the
  // chart's location colours never disagree with the surrounding CSS variables.
  const isDark = document.documentElement.classList.contains('dark');
  const textColor = isDark ? '#a0a09a' : '#6b6b66';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  // Line + shading take the current location's accent (West=amber, Centraal=green)
  const lineColor = loc === 'centraal' ? (isDark ? '#4EC9A0' : '#0F6E56') : (isDark ? '#E4A84D' : '#BA7517');
  const fillColor = loc === 'centraal' ? (isDark ? 'rgba(78,201,160,0.14)' : 'rgba(15,110,86,0.08)') : (isDark ? 'rgba(228,168,77,0.14)' : 'rgba(186,117,23,0.08)');

  const pad = { top: 14, right: 12, bottom: 24, left: 32 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  if (totalGuests === 0) {
    ctx.fillStyle = textColor;
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No guest data for today', w / 2, h / 2);
    return;
  }

  const maxGuests = Math.max(...data.map(d => d.guests), 1);
  const yMax = Math.ceil(maxGuests / 2) * 2 || 2;

  const xOf = (i: number) => pad.left + (i / (data.length - 1)) * cw;
  const yOf = (v: number) => pad.top + ch - (v / yMax) * ch;

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const yVal = (yMax / 3) * i;
    const y = yOf(yVal);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(yVal)), pad.left - 5, y + 3);
  }

  ctx.fillStyle = textColor;
  ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  data.forEach((d, i) => {
    const mins = parseInt(d.time.split(':')[1]);
    if (mins === 0 || mins === 30) {
      ctx.fillText(d.time, xOf(i), h - 4);
    }
  });

  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  data.forEach((d, i) => ctx.lineTo(xOf(i), yOf(d.guests)));
  ctx.lineTo(xOf(data.length - 1), yOf(0));
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  ctx.beginPath();
  data.forEach((d, i) => {
    if (i === 0) ctx.moveTo(xOf(i), yOf(d.guests));
    else ctx.lineTo(xOf(i), yOf(d.guests));
  });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Current time indicator
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = parseInt(data[0].time.split(':')[0]) * 60 + parseInt(data[0].time.split(':')[1]);
  const endMins = parseInt(data[data.length - 1].time.split(':')[0]) * 60 + parseInt(data[data.length - 1].time.split(':')[1]);
  if (nowMins >= startMins && nowMins <= endMins) {
    const progress = (nowMins - startMins) / (endMins - startMins);
    const nowX = pad.left + progress * cw;
    ctx.strokeStyle = isDark ? 'rgba(232,107,90,0.6)' : 'rgba(153,60,29,0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(nowX, pad.top);
    ctx.lineTo(nowX, pad.top + ch);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = isDark ? '#E86B5A' : '#993C1D';
    ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Now', nowX, pad.top - 3);

    const remaining = Math.round(data.reduce((sum: number, d) => {
      const slotMins = parseInt(d.time.split(':')[0]) * 60 + parseInt(d.time.split(':')[1]);
      return sum + (slotMins >= nowMins ? d.guests : 0);
    }, 0));
    const slotWidth = (endMins - startMins) / (data.length - 1);
    const floatIdx = (nowMins - startMins) / slotWidth;
    const loIdx = Math.floor(floatIdx);
    const hiIdx = Math.min(loIdx + 1, data.length - 1);
    const frac = floatIdx - loIdx;
    const nowGuests = data[loIdx].guests + (data[hiIdx].guests - data[loIdx].guests) * frac;
    const labelY = yOf(nowGuests);
    ctx.fillStyle = isDark ? '#E86B5A' : '#993C1D';
    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${remaining} left`, nowX, labelY + 14);
  }

  // Peak label
  const peakIdx = data.reduce((best: number, d, i) => d.guests > data[best].guests ? i : best, 0);
  const peakD = data[peakIdx];
  ctx.fillStyle = lineColor;
  ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`~${Math.round(peakD.guests)}/5min`, xOf(peakIdx), yOf(peakD.guests) - 6);
}

// ── Day todos persistence ────────────────────────────────────

export function _dayTodosKey() { return `sering-todos-${todayIso()}`; }

export function loadDayTodos() {
  try {
    const data = JSON.parse(localStorage.getItem(_dayTodosKey()) || '{}');
    S.heatChecked   = new Set(data.heat   || []);
    S.customTodos   = data.custom || [];
  } catch (e: unknown) {
    S.heatChecked = new Set();
    S.customTodos = [];
  }
}

export function saveDayTodos() {
  localStorage.setItem(_dayTodosKey(), JSON.stringify({
    heat:   [...S.heatChecked],
    custom: S.customTodos,
  }));
}

export function toggleHeatItem(dishId: string) {
  S.heatChecked.has(dishId) ? S.heatChecked.delete(dishId) : S.heatChecked.add(dishId);
  saveDayTodos();
  renderDashboardContent();
}

/** "What to Cook" checkbox handler. Batches with no recipe have nothing to
 *  resolve, so they go straight to the standard mark-cooked flow (confirmCooked
 *  forces the kitchen chooser itself on the dashboard). Recipe batches first
 *  pick the kitchen — the dashboard's currentLoc is ambiguous — then open the
 *  batch recipe editor in confirm-cook mode, where Save marks the batch cooked
 *  at the chosen location. */
export function startCookConfirm(dishId: string) {
  const d = S.batches.find(x => x.id === dishId);
  if (!d) return;
  if (!d.recipeId) {
    confirmCooked(dishId);
    return;
  }
  showModal(`<h3>Where did you cook "${esc(d.name)}"?</h3>
    <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">Pick the kitchen — this sets where the cooked stock lands.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="cookConfirmAt('${esc(dishId)}','west')">Sering West</button>
      <button class="btn btn-primary" onclick="cookConfirmAt('${esc(dishId)}','centraal')">Sering Centraal</button>
    </div>`);
}

/** Kitchen picked from the startCookConfirm chooser → open the batch recipe
 *  editor in confirm-cook mode for that location. */
export function cookConfirmAt(dishId: string, cookLoc: Location) {
  closeModal();
  openBatchRecipe(dishId, { confirmCook: true, cookLoc });
}

// ── Team todos (inline) ──────────────────────────────────────

export function addCustomTodo(text: string) {
  if (!text.trim()) return;
  S.customTodos.push({ id: newId(), text: text.trim(), done: false });
  saveDayTodos();
  renderDashboardContent();
  setTimeout(() => (document.getElementById('custom-todo-input') as HTMLInputElement)?.focus(), 0);
}

export function toggleCustomTodo(id: string) {
  const t = S.customTodos.find(x => x.id === id);
  if (t) { t.done = !t.done; saveDayTodos(); renderDashboardContent(); }
}

export function deleteCustomTodo(id: string) {
  S.customTodos = S.customTodos.filter(x => x.id !== id);
  saveDayTodos();
  renderDashboardContent();
}

// Keep legacy exports but no-op
export function toggleTeamTodos() { S.teamTodosOpen = !S.teamTodosOpen; renderDashboardContent(); }
export function renderTeamTodos() {}

// ── Prep checklist ───────────────────────────────────────────

export function togglePrepItem(loc: string, key: string) {
  if (!S.prepChecklist[loc]) S.prepChecklist[loc] = new Set();
  if (S.prepChecklist[loc].has(key)) {
    S.prepChecklist[loc].delete(key);
  } else {
    S.prepChecklist[loc].add(key);
  }
  schedulePrepSave(loc);
  renderPrepChecklist();
}

// ── Stocktake modal ──────────────────────────────────────────

let _stocktakeActive = false;
let _stocktakeArea: string | null = null;
let _stocktakeValues: Record<string, number | undefined> = {};
let _stocktakeSavedAreas: string[] = [];

export function openStocktakeModal() {
  _stocktakeActive = true;
  _stocktakeArea = null;
  _stocktakeValues = {};
  _stocktakeSavedAreas = [];
  renderStocktakeModal();
}

// Type for stocktake items (returned by getIngredientsForArea which spreads ...ing)
type StocktakeItem = ReturnType<typeof getIngredientsForArea>[number];

function renderStocktakeModal() {
  const loc = S.currentLoc;
  const areas = getStorageConfigForLoc(loc);

  if (!_stocktakeArea) {
    // Area picker
    let html = `<div class="dash-stocktake-modal">
      <h3 style="margin:0 0 4px;">📋 Stocktake</h3>
      <p style="color:var(--text2);margin:0 0 16px;font-size:12px;">${esc(locName(loc))} — Select a storage area</p>
      <div style="display:grid;gap:8px;">`;

    areas.forEach(area => {
      const items = getIngredientsForArea(area.name);
      const isSaved = _stocktakeSavedAreas.includes(area.name);
      html += `<button class="btn" style="display:flex;align-items:center;gap:10px;padding:12px 16px;font-size:14px;border-left:4px solid ${area.color || '#999'};text-align:left;background:${isSaved ? 'var(--bg2)' : 'var(--bg)'};" onclick="dashStocktakeEnterArea('${esc(area.name)}')">
        <span style="flex:1;"><span style="font-weight:600;">${isSaved ? '✅ ' : ''}${esc(area.name)}</span>
        <span style="font-size:12px;color:var(--text2);margin-left:6px;">${items.length} items</span></span>
        <span style="font-size:18px;">→</span>
      </button>`;
    });

    html += `</div>
      <div style="margin-top:16px;display:flex;gap:10px;">
        <button class="btn btn-sm" onclick="closeModal()">Close</button>
        ${_stocktakeSavedAreas.length ? `<button class="btn btn-sm" style="background:var(--green);color:white;" onclick="closeModal()">Done</button>` : ''}
      </div>
    </div>`;

    showModal(html);
  } else {
    // Area stocktake
    const items = getIngredientsForArea(_stocktakeArea) as StocktakeItem[];
    const areaConfig = areas.find(a => a.name === _stocktakeArea);
    const areaColor = areaConfig ? areaConfig.color : '#999';

    // Group by spot
    const bySpot: Record<string, StocktakeItem[]> = {};
    items.forEach(ing => {
      const spot = ing.spot || 'No spot assigned';
      if (!bySpot[spot]) bySpot[spot] = [];
      bySpot[spot].push(ing);
    });

    let html = `<div class="dash-stocktake-modal">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;border-left:4px solid ${areaColor};padding-left:10px;">
        <div>
          <h3 style="margin:0;font-size:16px;">📋 ${esc(_stocktakeArea)}</h3>
          <p style="color:var(--text2);margin:2px 0 0;font-size:11px;">${items.length} items</p>
        </div>
      </div>`;

    if (!items.length) {
      html += `<div class="dash-empty">No items in this area.</div>`;
    } else {
      Object.keys(bySpot).forEach(spot => {
        const spotItems = bySpot[spot];
        html += `<div style="margin-bottom:12px;">
          <div style="font-weight:600;font-size:12px;padding:3px 0;border-bottom:2px solid ${areaColor};margin-bottom:3px;">📍 ${esc(spot)}</div>`;

        spotItems.forEach((ing: StocktakeItem) => {
          const prefill = _stocktakeValues[ing.id] !== undefined ? _stocktakeValues[ing.id] : '';
          const unitLabel = ing.orderUnit || ing.unit || 'units';
          html += `<div class="dash-st-row">
            <span class="dash-st-name">${esc(ing.name)}</span>
            <input class="dash-st-input" type="number" min="0" step="0.5" value="${prefill !== '' ? prefill : ''}" placeholder="—"
              data-ing-id="${esc(ing.id)}" oninput="dashStocktakeUpdate(this)" />
            <span class="dash-st-unit">${esc(unitLabel)}</span>
          </div>`;
        });

        html += `</div>`;
      });
    }

    html += `<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
      <button class="btn btn-sm" onclick="dashStocktakeBack()">← Back</button>
      <button class="btn btn-sm" style="background:var(--green);color:white;flex:1;" onclick="dashStocktakeSave(true)">Save & next →</button>
      <button class="btn btn-sm" style="flex:1;" onclick="dashStocktakeSave(false)">Save & done</button>
    </div>
    </div>`;

    showModal(html);
    // Focus first empty input
    setTimeout(() => {
      const first = document.querySelector('.dash-st-input[value=""]') as HTMLInputElement;
      if (first) first.focus();
    }, 50);
  }
}

export function dashStocktakeEnterArea(areaName: string) {
  _stocktakeArea = areaName;
  renderStocktakeModal();
}

export function dashStocktakeBack() {
  _stocktakeArea = null;
  renderStocktakeModal();
}

export function dashStocktakeUpdate(input: HTMLInputElement) {
  const ingId = input.dataset.ingId;
  if (ingId) _stocktakeValues[ingId] = input.value === '' ? undefined : parseFloat(input.value);
}

export async function dashStocktakeSave(goToNext: boolean) {
  const loc = S.currentLoc;
  const items = getIngredientsForArea(_stocktakeArea!) as StocktakeItem[];

  // Collect values from DOM
  document.querySelectorAll('.dash-st-input').forEach((input: Element) => {
    const el = input as HTMLInputElement;
    const ingId = el.dataset.ingId;
    if (ingId) _stocktakeValues[ingId] = el.value === '' ? undefined : parseFloat(el.value);
  });

  // Persistence delegated to public/js/stocktake.ts (shared with the
  // orders full-screen flow).
  try {
    await saveStocktakeWithToast(_stocktakeArea!, items, _stocktakeValues, loc);
  } catch {
    return; // toast shown by helper
  }

  _stocktakeSavedAreas.push(_stocktakeArea!);

  if (goToNext) {
    _stocktakeArea = null;
    renderStocktakeModal();
  } else {
    closeModal();
    renderDashboardContent();
  }
}

// ── Cooked-food inventory freshness ──────────────────────────
// Shows for both locations how long ago the most recent inventory was
// completed. The Stock card otherwise only reflects the *current* location,
// so this strip is what tells the user whether the data they're looking at
// (and the data at the other site) is up to date. Falls back to "no
// inventory yet" until at least one window has been finished today.

const STALE_HOURS = 6;

function _latestCompletion(loc: Location): string | null {
  const c = S.inventoryCompletions[loc];
  if (!c) return null;
  const a = c.lunch ? Date.parse(c.lunch) : -Infinity;
  const b = c.dinner ? Date.parse(c.dinner) : -Infinity;
  if (a === -Infinity && b === -Infinity) return null;
  return a >= b ? c.lunch : c.dinner;
}

export function renderInventoryFreshness(): string {
  const items = (['west', 'centraal'] as Location[]).map(loc => {
    const ts = _latestCompletion(loc);
    const rel = formatRelativeTime(ts);
    let stale = false;
    if (ts) {
      const ageHr = (Date.now() - Date.parse(ts)) / 36e5;
      stale = ageHr >= STALE_HOURS;
    }
    const cls = !ts ? 'never' : stale ? 'stale' : 'fresh';
    const label = !ts ? 'no inventory yet' : `${rel}`;
    return `<button class="dash-inv-fresh-chip ${cls}" onclick="openInventory('${loc}')" title="Click to open ${esc(locName(loc))} inventory">
      <span class="dash-inv-fresh-loc">${esc(locName(loc))}</span>
      <span class="dash-inv-fresh-age">${esc(label)}</span>
    </button>`;
  }).join('');
  return `<div class="dash-inv-fresh-row" title="Time since the last 'Finish inventory' was pressed for each location">${items}</div>`;
}

// Re-render the dashboard once a minute so the "X min ago" counters keep
// counting up without the user touching anything. Cheap — `renderDashboardContent`
// rebuilds the planner and re-paints the dashboard, but only when that screen
// is actually visible.
let _freshTickStarted = false;
function _startFreshnessTick() {
  if (_freshTickStarted) return;
  _freshTickStarted = true;
  setInterval(() => {
    const screen = document.getElementById('screen-dashboard');
    if (screen && screen.style.display !== 'none' && screen.offsetParent !== null) {
      renderDashboardContent();
    }
  }, 60_000);
}

// ── MAIN CONTENT RENDER ──────────────────────────────────────

// Compact "Supplies" card on the dashboard. Shows non-archived supplies with
// per-location stock vs forward demand at the current dashboard location;
// flags deficits so the user can spot under-stocked toppings/bread/ferments
// at a glance. Active one-offs at this location are shown with their drip-feed
// amount instead of a deficit bar.
function renderSuppliesCard(loc: Location, todayStr: string): string {
  const supplies = (S.supplies || []).filter(s => !s.archived);
  if (supplies.length === 0) {
    return ''; // hide entirely until at least one supply exists
  }
  const rows = supplies.map(s => {
    const stockHere = s.stock?.[loc]?.amount ?? 0;
    const lastMake = s.stock?.[loc]?.lastMakeDate;
    if (s.kind === 'standard') {
      const demand = computeSupplyDemand(s, S.guests, S.caterings || [], todayStr);
      const need = loc === 'west' ? demand.west : demand.centraal;
      // Centralized supplies only prep at West; show West demand at both locations
      // so cooks can see "we need 5kg aioli" regardless of which dashboard they're on
      const showNeed = s.prepMode === 'centralized' ? demand.west : need;
      const deficit = Math.max(0, Math.round(showNeed - stockHere));
      const color = deficit > 0 ? 'var(--red)' : 'var(--text2)';
      return `<div class="dash-supply-row" style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
        <span>${esc(s.name)}${s.prepMode === 'centralized' && loc !== 'west' ? ' <span style="font-size:10px;color:var(--text3);">(from West)</span>' : ''}</span>
        <span style="font-size:12px;color:${color};">
          ${stockHere} / ${Math.round(showNeed)} ${esc(s.unit)}
          ${deficit > 0 ? ` <strong>−${deficit}</strong>` : ''}
          ${lastMake ? `<span style="font-size:10px;color:var(--text3);"> · ${lastMake}</span>` : ''}
        </span>
      </div>`;
    }
    // one-off
    if (s.oneoffLocation !== loc) return '';
    return `<div class="dash-supply-row" style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
      <span>${esc(s.name)} <span style="font-size:10px;color:var(--text3);">(one-off)</span></span>
      <span style="font-size:12px;color:var(--text2);">${stockHere} ${esc(s.unit)} left · ${s.unitsPerService}/service</span>
    </div>`;
  }).filter(Boolean).join('');
  if (!rows) return '';
  // Per-cover cost: sum of price-per-guest across standard supplies that have
  // a cost set. Shows what toppings & bread add to each guest's food cost.
  let costPerGuest = 0;
  let costedCount = 0;
  for (const s of supplies) {
    const ppg = supplyPricePerGuest(s);
    if (ppg != null) { costPerGuest += ppg; costedCount++; }
  }
  const costFooter = costedCount > 0
    ? `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border);font-size:12px;color:var(--text2);display:flex;justify-content:space-between;">
        <span>Toppings &amp; bread per guest</span>
        <strong>&euro;${costPerGuest.toFixed(2)}</strong>
      </div>`
    : '';
  return `<div class="dash-card">
    <div class="dash-card-title">
      <span class="dash-card-icon">🥬</span> Toppings &amp; bread
      <button class="btn btn-sm" style="margin-left:auto;" onclick="showScreen('supplies')">Manage</button>
    </div>
    <div style="margin-top:6px;">${rows}</div>
    ${costFooter}
  </div>`;
}

export function renderDashboardContent() {
  _startFreshnessTick();
  const el = document.getElementById('dash-content');
  if (!el) return;

  rebuildPlanner();
  const loc = S.currentLoc;
  const today = getToday();
  const todayStr = dateToIso(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = dateToIso(tomorrow);
  const meal = S.dashMeal;
  const dateLabel = today.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  // ── Guest counts for toggle buttons ──
  const lunchGuests = getGuests(loc, todayStr, 'lunch');
  const dinnerGuests = getGuests(loc, todayStr, 'dinner');
  const mealGuests = meal === 'lunch' ? lunchGuests : dinnerGuests;

  // ── Menu dishes for selected meal ──
  const menuDishes = getMenuDishesForMeal(loc, todayStr, meal) as DashBatch[];
  const typeOrder: Record<string, number> = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
  const sortedMenu = [...menuDishes].sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

  // ── Stock overview ──
  // Show batches with settled stock at this loc (in-flight shipments are
  // tracked separately in the transport view). Per-loc qty drives the
  // sort + totals so the cook sees what's physically here.
  const stockBatches = S.batches
    .filter(b => getStockAt(b, loc) > 0)
    .sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || a.name.localeCompare(b.name));
  const totalStock = Math.round(stockBatches.reduce((s, b) => s + getStockAt(b, loc), 0) * 10) / 10;

  // ── Cook: uncooked batches for selected meal today ──
  const cookDishes = (S.planner[`${loc}-${todayStr}-${meal}`] || []).filter(d => !isBatchCooked(d));

  // ── Chop: ingredients for selected meal today + tomorrow ──
  const vegToday = getVegIngredients(getMenuDishesForMeal(loc, todayStr, meal));
  const vegTomorrow = getVegIngredients(getMenuDishesForMeal(loc, tomorrowStr, meal));
  const prepToday = vegToday.map(i => ({ ...i, dayTag: 'today', key: `today-${i.name.toLowerCase().trim()}` }));
  const prepTomorrow = vegTomorrow.map(i => ({ ...i, dayTag: 'tomorrow', key: `tomorrow-${i.name.toLowerCase().trim()}` }));
  const allPrep = [...prepToday, ...prepTomorrow];
  const checkedSet = S.prepChecklist[loc] || new Set();
  const doneCount = allPrep.filter(i => checkedSet.has(i.key)).length;

  // ── Team todos ──
  const undone = S.customTodos.filter(t => !t.done).length;

  el.innerHTML = `
    <!-- ═══ MEAL TOGGLE ═══ -->
    <div class="dash-meal-toggle">
      <button class="dash-meal-btn ${meal === 'lunch' ? 'active lunch' : 'lunch'}" onclick="setDashMeal('lunch')">
        ☀️ Lunch <span class="dash-meal-count">${lunchGuests}</span>
      </button>
      <button class="dash-meal-btn ${meal === 'dinner' ? 'active dinner' : 'dinner'}" onclick="setDashMeal('dinner')">
        🌙 Dinner <span class="dash-meal-count">${dinnerGuests}</span>
      </button>
    </div>

    <!-- ═══ CENTRAAL TRANSPORT ARRIVAL ═══ -->
    ${renderCentraalArrivalBlock()}

    <!-- ═══ SERVICE BLOCK ═══ -->
    <div class="dash-service-cols">
      <div class="dash-card">
        <div class="dash-card-title">${meal === 'lunch' ? '☀️' : '🌙'} ${meal.charAt(0).toUpperCase() + meal.slice(1)} Menu</div>
        ${sortedMenu.length === 0
          ? `<div class="dash-empty">No batches planned for ${meal}</div>`
          : renderGroupedByType(sortedMenu, d => renderDashChip(d, {
              meal,
              dateStr: todayStr,
              liters: calcLitersForService(d, loc, todayStr, meal),
              showAllergens: true,
              showStarch: true,
              showRecipe: true,
            }))
        }
        ${starchSummaryHtml(sortedMenu, mealGuests)}
      </div>
      <div class="dash-card">
        <div class="dash-card-title">👥 Guests Expected</div>
        <div class="dash-guest-big">
          <span class="dash-guest-num">${mealGuests}</span>
          <span class="dash-guest-label">guests expected</span>
        </div>
        <div class="dash-flow-wrap">
          <div class="dash-flow-canvas-wrap"><canvas id="guest-flow-canvas"></canvas></div>
        </div>
      </div>
    </div>

    <!-- ═══ TWO-COLUMN LAYOUT ═══ -->
    <div class="dash-columns">

      <!-- LEFT: STOCK + TRANSPORT -->
      <div class="dash-col">
        <div class="dash-card">
          <div class="dash-card-title">
            <span class="dash-card-icon">📦</span> Stock
            <span class="dash-stock-total">${stockBatches.length} batches — ${totalStock} L</span>
            <button class="btn btn-sm dash-inv-btn" onclick="openInventory('${loc}')">🍽️ Cooked Food Inventory</button>
            <button class="btn btn-sm dash-st-btn" onclick="openStocktakeModal()">📋 Ingredient Stocktake</button>
          </div>
          ${renderInventoryFreshness()}
          ${stockBatches.length === 0
            ? `<div class="dash-empty">No food in stock</div>`
            : (() => {
                // Per-loc Frozen split: a batch counts as "Frozen at this loc"
                // when ALL its inventory entries at this loc are Frozen. Any
                // non-frozen entry at the loc puts it in the "fresh" bucket
                // (mixed batches surface in the fresh bucket so the cook sees
                // them as available; the frozen-only batches show up explicitly
                // under the ❄️ section).
                const isFrozenAtLoc = (b: Batch) => {
                  const here = (b.inventory || []).filter(e => e.loc === loc && (e.qty || 0) > 0);
                  return here.length > 0 && here.every(e => e.storage === 'Frozen');
                };
                const fresh = stockBatches.filter(b => !isFrozenAtLoc(b));
                const frozen = stockBatches.filter(b => isFrozenAtLoc(b));
                let h = renderGroupedByType(fresh, b => renderDashChip(b, {
                  showStock: true,
                  note: !isBatchCooked(b) ? 'uncooked' : undefined,
                }));
                if (frozen.length) {
                  h += `<div class="dash-section-hdr" style="margin-top:8px;">❄️ Frozen</div>`;
                  h += frozen.map(b => renderDashChip(b, {
                    showStock: true,
                    note: 'frozen',
                  })).join('');
                }
                return h;
              })()
          }
        </div>
        ${renderSuppliesCard(loc, todayStr)}
        ${renderTransportCard()}
      </div>

      <!-- RIGHT: CHEF TO-DOS -->
      <div class="dash-col">
        <!-- WHAT TO COOK -->
        <div class="dash-card">
          <div class="dash-card-title"><span class="dash-card-icon">👨‍🍳</span> What to Cook</div>
          ${cookDishes.length === 0
            ? `<div class="dash-empty">All cooked for ${meal} 🎉</div>`
            : cookDishes.map(d => renderDashChip(d, {
                meal,
                dateStr: todayStr,
                liters: calcRequired(d),
                note: 'cook today',
                checkable: true,
                toggleFn: 'startCookConfirm',
              })).join('')
          }
        </div>

        <!-- WHAT TO CHOP -->
        <div class="dash-card">
          <div class="dash-card-title">
            <span class="dash-card-icon">🔪</span> What to Chop
            ${allPrep.length > 0 ? `<span class="dash-prep-progress">${doneCount}/${allPrep.length}</span>` : ''}
          </div>
          <div id="dash-prep-list"></div>
        </div>

        <!-- TEAM TODOS (inline) -->
        <div class="dash-card">
          <div class="dash-card-title">
            <span class="dash-card-icon">📝</span> Team To-Dos
            ${undone > 0 ? `<span class="dash-prep-progress" style="background:var(--amber-bg);color:var(--amber);">${undone}</span>` : ''}
          </div>
          <div class="dash-custom-input-row">
            <input class="dash-custom-input" id="custom-todo-input" type="text" placeholder="e.g. Clean walk-in fridge..."
              onkeydown="if(event.key==='Enter')addCustomTodo(this.value)">
            <button class="dash-custom-add-btn" onclick="addCustomTodo(document.getElementById('custom-todo-input').value)">Add</button>
          </div>
          ${S.customTodos.length === 0
            ? `<div class="dash-empty">No todos yet</div>`
            : S.customTodos.map(t => `
              <div class="dash-prep-item${t.done ? ' checked' : ''}" onclick="toggleCustomTodo('${esc(t.id)}')">
                <div class="dash-prep-check">${t.done ? '✓' : ''}</div>
                <span class="dash-prep-name">${esc(t.text)}</span>
                <button class="dash-todo-del" onclick="event.stopPropagation();deleteCustomTodo('${esc(t.id)}')">✕</button>
              </div>`).join('')
          }
        </div>
      </div>
    </div>
  `;

  renderPrepChecklist();
  drawGuestFlowChart();
}

// ── Prep checklist render (partial) ──────────────────────────

/** Standard supplies whose stock at `loc` is below forward demand — surfaced
 *  as "Make X of Y" tasks in the prep checklist. Centralized supplies are
 *  prepped at West only, so they appear on the West checklist regardless of
 *  which location the dashboard is showing. */
interface SupplyPrepTask { supply: Supply; make: number; have: number; need: number; }
function computeSupplyPrepTasks(loc: Location, todayStr: string): SupplyPrepTask[] {
  const tasks: SupplyPrepTask[] = [];
  for (const s of (S.supplies || [])) {
    if (s.archived || s.kind !== 'standard') continue;
    if (s.prepMode === 'centralized' && loc !== 'west') continue;
    const demand = computeSupplyDemand(s, S.guests, S.caterings || [], todayStr);
    const need = s.prepMode === 'centralized'
      ? demand.west
      : (loc === 'centraal' ? demand.centraal : demand.west);
    const have = s.stock?.[loc]?.amount ?? 0;
    const make = need - have;
    if (make > 0.0001) tasks.push({ supply: s, make, have, need });
  }
  return tasks;
}

export function renderPrepChecklist() {
  const el = document.getElementById('dash-prep-list');
  if (!el) return;

  rebuildPlanner();
  const loc = S.currentLoc;
  const today = getToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const todayStr = dateToIso(today);
  const tomorrowStr = dateToIso(tomorrow);
  const meal = S.dashMeal;

  const vegToday = getVegIngredients(getMenuDishesForMeal(loc, todayStr, meal));
  const vegTomorrow = getVegIngredients(getMenuDishesForMeal(loc, tomorrowStr, meal));

  const prepToday = vegToday.map(i => ({ ...i, dayTag: 'today', key: `today-${i.name.toLowerCase().trim()}` }));
  const prepTomorrow = vegTomorrow.map(i => ({ ...i, dayTag: 'tomorrow', key: `tomorrow-${i.name.toLowerCase().trim()}` }));
  const checkedSet = S.prepChecklist[loc] || new Set();
  const supplyTasks = computeSupplyPrepTasks(loc, todayStr);

  if (prepToday.length === 0 && prepTomorrow.length === 0 && supplyTasks.length === 0) {
    el.innerHTML = `<div class="dash-empty">No fresh ingredients to prep 🎉</div>`;
    return;
  }

  function renderItem(item: VegIngredient & { dayTag: string; key: string }) {
    const checked = checkedSet.has(item.key);
    const amt = Math.round(item.amount);
    const unit = item.unit || 'g';
    return `
      <div class="dash-prep-item${checked ? ' checked' : ''}" onclick="togglePrepItem('${esc(loc)}','${esc(item.key)}')">
        <div class="dash-prep-check">${checked ? '✓' : ''}</div>
        <span class="dash-prep-name">${esc(item.name)}</span>
        <span class="dash-prep-amt">${amt} ${esc(unit)}</span>
      </div>`;
  }

  const todayItems = prepToday.sort((a, b) => a.name.localeCompare(b.name));
  const tomorrowItems = prepTomorrow.sort((a, b) => a.name.localeCompare(b.name));
  let html = '';
  if (todayItems.length > 0) {
    const doneCt = todayItems.filter(i => checkedSet.has(i.key)).length;
    html += `<div class="dash-prep-group-hdr">
      🔥 Today
      <span class="dash-prep-group-count">${doneCt}/${todayItems.length}</span>
    </div>`;
    html += todayItems.map(renderItem).join('');
  }
  if (tomorrowItems.length > 0) {
    const doneCt = tomorrowItems.filter(i => checkedSet.has(i.key)).length;
    html += `<div class="dash-prep-group-hdr"${todayItems.length > 0 ? ' style="margin-top:8px;"' : ''}>
      📅 Tomorrow
      <span class="dash-prep-group-count">${doneCt}/${tomorrowItems.length}</span>
    </div>`;
    html += tomorrowItems.map(renderItem).join('');
  }
  // Toppings & bread to make — standard supplies under their forward demand.
  if (supplyTasks.length > 0) {
    html += `<div class="dash-prep-group-hdr"${(todayItems.length || tomorrowItems.length) ? ' style="margin-top:8px;"' : ''}>
      🥬 Toppings &amp; bread to make
      <span class="dash-prep-group-count">${supplyTasks.length}</span>
    </div>`;
    html += supplyTasks.map(t => {
      const make = Math.ceil(t.make);
      const unit = esc(t.supply.unit);
      return `
      <div class="dash-prep-item dash-prep-supply">
        <span class="dash-prep-name">Make ${esc(t.supply.name)}</span>
        <span class="dash-prep-amt">~${make} ${unit} <span style="color:var(--text3);">(have ${Math.round(t.have)})</span></span>
        <button class="btn btn-sm" onclick="suppliesOpenLogPrep('${esc(t.supply.id)}',${make},'${loc}')">Log prep</button>
      </div>`;
    }).join('');
  }
  el.innerHTML = html;
}

export function navTo(screen: string, subTab: string) {
  if (subTab) S.plannerSubTab = subTab;
  showScreen(screen);
}

/** Re-render the dashboard's content in place if it has been mounted at least
 *  once this session. Safe to call while the dashboard is NOT the visible
 *  screen — registered as the background-refresh hook so "Pack for Centraal"
 *  and the other cards stay in sync with edits made on other screens. No-op
 *  before the first dashboard visit (#dash-content doesn't exist yet). */
export function refreshDashboardIfMounted(): void {
  if (document.getElementById('dash-content')) {
    renderDashboardContent();
  }
}

// Self-register so navigate.ts can dispatch without importing every screen.
// Other screens self-register from their own files; this one stays here
// because dashboard.ts owns its render fn.
registerRenderer('dashboard', renderDashboard);
// Keep the dashboard's passive cards live when the user edits on other screens.
setBackgroundRefresh(refreshDashboardIfMounted);
