import type { Batch, Location, Meal, DishType } from '@shared/types';
import { S, DAYS, MEALS, LOCATIONS, ALLERGENS, ACCOMPANIMENTS, NAV_SCREENS } from './state';

/** Batch with optional dashboard-only starch selection (not persisted in shared type) */
type DashBatch = Batch & { starch?: string | null };
import { scheduleSave, toast, toastError, loadPrepChecklist, schedulePrepSave, todayIso, loadData, connectLiveSync, newId } from './utils';
import { rebuildPlanner, getAmsterdamNow, dateToDayName, dateToIso, isServicePast, calcRequired, calcRequiredBreakdown, calcTotalGuests, calcIngredientsFromRecipe, locationBadge, storageBadge, storageBadgeClass, logisticsBadge, logisticsBadgeClass, logisticsShort, typeBadge, typeBadgeClass, TYPES, isBatchCooked, getGuests, getToday, dateToStr, chipClass } from './core';
import { getVisibleDays, getMondayKeyForDate, localDateStr, renderDayNav, AGG_MEALS, buildFlowDistribution } from './predictions';
import { calcRequiredForLoc, confirmCooked, inlineAddAllergenStart, inlineRemoveAllergen } from './dishes';
import { esc } from './modal';
import { registerRenderer, setCurrentScreen } from './navigate';
import { renderFeedbackAdmin } from './feedback-admin';
import { renderFinance } from './finance';
import { renderGuests } from './guests';
import { renderOrders, startStocktake, renderStocktakeAreaPicker, enterStocktakeArea, renderStocktakeArea, saveStocktakeArea, exitStocktake, getIngredientsForArea } from './orders';
import { renderRecipeIndex } from './recipes';
import { renderWeekPlan } from './planner';
import { trackScreenView } from './telemetry';
import { showModal, closeModal } from './modal';
import { getStorageConfigForLoc } from './state';
import { locName } from '@shared/location';

// SCREENS
// ═══════════════════════════════════════════════════════════════════

export function showScreen(name: string, pushState = true) {
  trackScreenView(name);
  setCurrentScreen(name);
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name)?.classList.add('active');
  document.querySelectorAll('.nav-btn, .bnav-btn').forEach(b => {
    b.classList.toggle('active', (b as HTMLElement).dataset.screen === name);
  });
  if (pushState) {
    const hash = name === 'dashboard' ? '' : '#' + name;
    if (window.location.hash !== hash && !(name === 'dashboard' && !window.location.hash)) {
      history.pushState({ screen: name }, '', hash || window.location.pathname);
    }
  }
  if (name === 'planner' || name === 'dashboard' || name === 'orders') rebuildPlanner();
  if (name === 'dashboard') renderDashboard();
  if (name === 'guests') renderGuests();
  if (name === 'planner') renderWeekPlan();
  if (name === 'recipe-index') renderRecipeIndex();
  if (name === 'orders') renderOrders();
  if (name === 'finance') renderFinance();
  if (name === 'feedback-admin') renderFeedbackAdmin();
}

export function getScreenFromHash(): string {
  const hash = window.location.hash.replace('#', '');
  const validScreens = NAV_SCREENS.map(s => s.id);
  return validScreens.includes(hash) ? hash : 'dashboard';
}

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

export function isDishAtLocation(dish: Batch, loc: Location) {
  return dish.location === loc;
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
  const g = getGuests(loc, dateStr, meal);
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

  // Compact row
  let html = `<div class="dash-chip ${expanded ? 'expanded' : ''} ${ctx.checked ? 'checked' : ''}">
    <div class="dash-chip-row" onclick="${ctx.checkable && ctx.toggleFn ? ctx.toggleFn + "('" + esc(dish.id) + "')" : "toggleDashChipExpand('" + esc(dish.id) + "')"}">`;

  if (ctx.checkable) {
    html += `<div class="dash-prep-check">${ctx.checked ? '✓' : ''}</div>`;
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
  } else if (ctx.showStock && (dish.stock || 0) > 0) {
    html += `<span class="dash-chip-liters">${dish.stock} L</span>`;
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
      <span>${dish.stock || 0} L ${cooked ? '<span class="dash-chip-badge-ok">cooked</span>' : '<span class="dash-chip-badge-warn">uncooked</span>'}</span>
    </div>`;
    if (dish.cookDate) {
      html += `<div class="dash-chip-detail-row">
        <span class="dash-chip-detail-label">Cook date</span>
        <span>${esc(dish.cookDate)}</span>
      </div>`;
    }

    // Recipe link
    if (dish.recipeSheetId) {
      html += `<div class="dash-chip-detail-row">
        <a class="dash-recipe-btn" href="https://docs.google.com/spreadsheets/d/${esc(dish.recipeSheetId)}" target="_blank" onclick="event.stopPropagation()">📄 Open Recipe</a>
      </div>`;
    } else if ((dish as Record<string, unknown>).recipeId) {
      html += `<div class="dash-chip-detail-row">
        <button class="dash-recipe-btn" onclick="event.stopPropagation();openRecipeDetail('${esc((dish as Record<string, unknown>).recipeId as string)}')">📄 View Recipe</button>
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

  const isDark = document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
  const textColor = isDark ? '#a0a09a' : '#6b6b66';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const lineColor = meal === 'lunch' ? (isDark ? '#E4A84D' : '#BA7517') : (isDark ? '#8B82E0' : '#534AB7');
  const fillColor = meal === 'lunch' ? (isDark ? 'rgba(228,168,77,0.12)' : 'rgba(186,117,23,0.08)') : (isDark ? 'rgba(139,130,224,0.12)' : 'rgba(83,74,183,0.08)');

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
    S.cookChecked   = new Set(data.cook   || []);
    S.customTodos   = data.custom || [];
  } catch (e: unknown) {
    S.heatChecked = new Set();
    S.cookChecked = new Set();
    S.customTodos = [];
  }
}

export function saveDayTodos() {
  localStorage.setItem(_dayTodosKey(), JSON.stringify({
    heat:   [...S.heatChecked],
    cook:   [...S.cookChecked],
    custom: S.customTodos,
  }));
}

export function toggleHeatItem(dishId: string) {
  S.heatChecked.has(dishId) ? S.heatChecked.delete(dishId) : S.heatChecked.add(dishId);
  saveDayTodos();
  renderDashboardContent();
}

export function toggleCookItem(dishId: string) {
  const d = S.batches.find(x => x.id === dishId);
  if (d && !isBatchCooked(d)) {
    confirmCooked(dishId);
    S.cookChecked.add(dishId);
    saveDayTodos();
    renderDashboardContent();
    return;
  }
  S.cookChecked.has(dishId) ? S.cookChecked.delete(dishId) : S.cookChecked.add(dishId);
  saveDayTodos();
  renderDashboardContent();
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

  const updates: Array<{ ingredientId: string; location: string; amount: number }> = [];
  items.forEach((ing: StocktakeItem) => {
    const val = _stocktakeValues[ing.id];
    if (val === undefined) return;
    const baseAmount = ing.orderUnitSize > 0 ? val * ing.orderUnitSize : val;
    updates.push({ ingredientId: ing.id, location: loc, amount: baseAmount });
  });

  if (updates.length) {
    try {
      await apiPost('/api/ingredients/stock/bulk', updates);
    } catch (e: unknown) {
      toastError('Failed to save stock: ' + (e instanceof Error ? e.message : 'Unknown error'));
      return;
    }
    updates.forEach(u => {
      const dbIng = S.ingredientDb.find(i => i.id === u.ingredientId);
      if (dbIng) {
        if (!dbIng.stock) dbIng.stock = {};
        (dbIng.stock as Record<string, unknown>)[u.location] = { amount: u.amount, date: new Date().toISOString().slice(0, 10) };
      }
    });
  }

  _stocktakeSavedAreas.push(_stocktakeArea!);
  toast(`${_stocktakeArea}: ${updates.length} items saved`);

  if (goToNext) {
    _stocktakeArea = null;
    renderStocktakeModal();
  } else {
    closeModal();
    renderDashboardContent();
  }
}

// ── MAIN CONTENT RENDER ──────────────────────────────────────

export function renderDashboardContent() {
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
  const stockBatches = S.batches
    .filter(b => b.location === loc && (b.stock || 0) > 0 && !b.inTransit)
    .sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || a.name.localeCompare(b.name));
  const totalStock = Math.round(stockBatches.reduce((s, b) => s + (b.stock || 0), 0) * 10) / 10;

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

      <!-- LEFT: STOCK -->
      <div class="dash-col">
        <div class="dash-card">
          <div class="dash-card-title">
            <span class="dash-card-icon">📦</span> Stock
            <span class="dash-stock-total">${stockBatches.length} batches — ${totalStock} L</span>
            <button class="btn btn-sm dash-inv-btn" onclick="openInventory('${loc}')">🍽️ Cooked Food Inventory</button>
            <button class="btn btn-sm dash-st-btn" onclick="openStocktakeModal()">📋 Ingredient Stocktake</button>
          </div>
          ${stockBatches.length === 0
            ? `<div class="dash-empty">No food in stock</div>`
            : (() => {
                const fresh = stockBatches.filter(b => b.storage !== 'Frozen');
                const frozen = stockBatches.filter(b => b.storage === 'Frozen');
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
                liters: calcLitersForService(d, loc, todayStr, meal),
                note: 'cook today',
                checkable: true,
                checked: S.cookChecked.has(d.id),
                toggleFn: 'toggleCookItem',
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

  if (prepToday.length === 0 && prepTomorrow.length === 0) {
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
  el.innerHTML = html;
}

export function navTo(screen: string, subTab: string) {
  if (subTab) S.plannerSubTab = subTab;
  showScreen(screen);
}

// ── Register screen renderers ────────────────────────────────
registerRenderer('dashboard', renderDashboard);
registerRenderer('guests', renderGuests);
registerRenderer('planner', renderWeekPlan);
registerRenderer('recipe-index', renderRecipeIndex);
registerRenderer('orders', renderOrders);
registerRenderer('finance', renderFinance);
registerRenderer('feedback-admin', renderFeedbackAdmin);
