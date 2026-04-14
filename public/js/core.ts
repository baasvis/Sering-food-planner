// CORE LOGIC
// ═══════════════════════════════════════════════════════════════════

import { S, DAYS, MEALS, STORAGE } from './state';
import type { Batch, Service, Catering, CateringDish, RecipeEntry, RecipeIngredient, Location, Meal, DishType, StorageType, BatchRatings } from '@shared/types';
import { scheduleSave, apiPost, toast } from './utils';
import { showModal, closeModal, esc } from './modal';
import { rerenderCurrentView } from './navigate';
import { renderBatchTile } from './dishes';

export function isBatchCooked(d: Batch): boolean {
  return (d.stock || 0) > 0;
}

export function locationBadge(d: Batch): string {
  if (d.location === 'centraal') {
    return `<span class="badge b-centraal">Sering Centraal</span>`;
  }
  return `<span class="badge b-west">Sering West</span>`;
}

// Amsterdam time helper (shared — also used by planner.js inventory)
export function getAmsterdamNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
}

// Convert a date string ("2026-03-23") to a day name ("Mon", "Tue", etc.)
export function dateToDayName(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00'); // noon to avoid timezone edge cases
  return DAYS[(d.getDay() + 6) % 7];
}

// Convert a JS Date object to ISO date string "2026-03-23"
export function dateToIso(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Check if a service is past / "served".
// Services store date as ISO string (e.g., "2026-03-23").
// A service is served when:
// - Its date is before today, OR
// - Its date is today AND (clock past deadline OR inventory done after urgent)
export function isServicePast(svc: Service): boolean {
  const now = getAmsterdamNow();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const svcDate = new Date(svc.date + 'T12:00:00');
  const svcDay = new Date(svcDate.getFullYear(), svcDate.getMonth(), svcDate.getDate());
  if (svcDay < today) return true;       // past date
  if (svcDay > today) return false;      // future date
  // Today — check time and inventory state
  const mins = now.getHours() * 60 + now.getMinutes();
  const lk: Location = svc.loc === 'west' ? 'west' : 'centraal';
  const todayStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const inv = S.inventoryDone[lk] || {};
  if (svc.meal === 'lunch') {
    const deadline = 13 * 60 + 45;     // 13:45
    const urgentFrom = deadline - 60;   // 12:45
    return mins >= deadline || (inv.lunch === todayStr && mins >= urgentFrom);
  }
  if (svc.meal === 'dinner') {
    const deadline = 20 * 60 + 15;     // 20:15
    const urgentFrom = deadline - 60;   // 19:15
    return mins >= deadline || (inv.dinner === todayStr && mins >= urgentFrom);
  }
  return false;
}

export function rebuildPlanner(): void {
  S.planner = {};
  S.batches.forEach((d: Batch) => {
    (d.services || []).forEach((svc: Service) => {
      const k = `${svc.loc}-${svc.date}-${svc.meal}`;
      if (!S.planner[k]) S.planner[k] = [];
      if (!S.planner[k].find((x: Batch) => x.id === d.id)) S.planner[k].push(d);
    });
  });
}

export function renderDishListSplit(dishes: Batch[]): string {
  const cooked = sortByCookDate(dishes.filter((d: Batch) => isBatchCooked(d)));
  const uncooked = sortByCookDate(dishes.filter((d: Batch) => !isBatchCooked(d)));
  let html = '';
  if (uncooked.length > 0) {
    html += `<div class="cook-group-hdr uncooked-hdr">To cook (${uncooked.length})</div>`;
    uncooked.forEach((d: Batch) => { html += renderBatchTile(d); });
  }
  if (cooked.length > 0) {
    html += `<div class="cook-group-hdr cooked-hdr">Cooked (${cooked.length})</div>`;
    cooked.forEach((d: Batch) => { html += renderBatchTile(d); });
  }
  return html;
}

export function sortByCookDate(dishes: Batch[]): Batch[] {
  return [...dishes].sort((a: Batch, b: Batch) => {
    const da = a.cookDate ? strToDate(a.cookDate) : null;
    const db = b.cookDate ? strToDate(b.cookDate) : null;
    // No date goes to bottom
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da.getTime() - db.getTime();
  });
}

// Get guest count for a location, date string, and meal
export function getGuests(loc: string, dateStr: string, meal: Meal | string): number {
  const lk = loc === 'west' ? 'west' : 'centraal';
  const dn = dateToDayName(dateStr);

  // Determine if dateStr falls in the current week
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  const mk = dateToIso(mon);

  const today = getToday();
  const todayDow = today.getDay();
  const curMon = new Date(today);
  curMon.setDate(today.getDate() + (todayDow === 0 ? -6 : 1 - todayDow));
  const curMk = dateToIso(curMon);

  // Current week: use S.guests (user-edited base counts)
  if (mk === curMk) {
    return ((S.guests[lk] || {})[dn] || {} as any)[meal] || 0;
  }

  // Future/past weeks: use guestsNextWeeks predictions
  const weekData = S.guestsNextWeeks[mk];
  if (weekData && weekData[lk] && weekData[lk][dn] && weekData[lk][dn][meal] !== undefined) {
    return weekData[lk][dn][meal];
  }

  // Final fallback to base counts
  return ((S.guests[lk] || {})[dn] || {} as any)[meal] || 0;
}

export function calcRequired(dish: Batch): number {
  let total = 0;
  (dish.services || []).forEach((svc: Service) => {
    if (isServicePast(svc)) return; // Skip served services — no longer pulling stock
    const g = getGuests(svc.loc, svc.date, svc.meal);
    const k = `${svc.loc}-${svc.date}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter((d: Batch) => d.type === dish.type);
    const count = Math.max(peers.length, 1);
    total += (g / count) * ((dish.serving || 280) / 1000);
  });
  // Add catering requirements (split by same-type peers)
  (S.caterings || []).forEach((c: Catering) => {
    const cd = (c.dishes || []).find((cd: CateringDish) => cd.dishId === dish.id);
    if (cd) {
      const peers = (c.dishes || []).filter((d: CateringDish) => d.type === dish.type).length;
      total += ((c.guestCount || 0) / Math.max(peers, 1)) * ((dish.serving || 280) / 1000);
    }
  });
  return Math.round(total * 10) / 10;
}

export interface BreakdownLine {
  text: string;
}

export function calcRequiredBreakdown(dish: Batch): string[] {
  const lines: string[] = [];
  (dish.services || []).forEach((svc: Service) => {
    const loc = svc.loc === 'west' ? 'Sering West' : 'Sering Centraal';
    const meal = svc.meal.charAt(0).toUpperCase() + svc.meal.slice(1);
    const dayName = dateToDayName(svc.date);
    // Past services show as "served" instead of contributing liters
    if (isServicePast(svc)) {
      lines.push(`\u2713 ${dayName} ${meal} ${loc} (served)`);
      return;
    }
    const g = getGuests(svc.loc, svc.date, svc.meal);
    const k = `${svc.loc}-${svc.date}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter((d: Batch) => d.type === dish.type);
    const count = Math.max(peers.length, 1);
    const liters = Math.round((g / count) * ((dish.serving || 280) / 1000) * 10) / 10;
    if (liters > 0) {
      lines.push(`${liters}L \u2014 ${dayName} ${meal} ${loc}`);
    }
  });
  (S.caterings || []).forEach((c: Catering) => {
    const cd = (c.dishes || []).find((cd: CateringDish) => cd.dishId === dish.id);
    if (cd) {
      const peers = (c.dishes || []).filter((d: CateringDish) => d.type === dish.type).length;
      const liters = Math.round(((c.guestCount || 0) / Math.max(peers, 1)) * ((dish.serving || 280) / 1000) * 10) / 10;
      if (liters > 0) lines.push(`${liters}L \u2014 ${c.name} (${c.guestCount} guests${peers > 1 ? ', 1/' + peers + ' split' : ''})`);
    }
  });
  return lines;
}

export function calcTotalGuests(dish: Batch): number {
  let g = 0;
  (dish.services || []).forEach((svc: Service) => {
    if (isServicePast(svc)) return; // Skip served services
    const total = getGuests(svc.loc, svc.date, svc.meal);
    const k = `${svc.loc}-${svc.date}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter((d: Batch) => d.type === dish.type);
    g += total / Math.max(peers.length, 1);
  });
  // Add catering guests (split by same-type peers)
  (S.caterings || []).forEach((c: Catering) => {
    const cd = (c.dishes || []).find((cd: CateringDish) => cd.dishId === dish.id);
    if (cd) {
      const peers = (c.dishes || []).filter((d: CateringDish) => d.type === dish.type).length;
      g += (c.guestCount || 0) / Math.max(peers, 1);
    }
  });
  return Math.round(g);
}

/** Check if a batch has recipe data (either legacy recipeIngredients or v2 recipeId) */
export function batchHasRecipe(b: Batch): boolean {
  return !!(b.recipeIngredients && b.recipeVolume) || !!b.recipeId;
}

export function calcIngredientsFromRecipe(dish: Batch): Array<{ name: string; amount: number; unit: string; source: string }> {
  // Try legacy denormalized ingredients first
  let ingredients: Array<{ name: string; amount: number; unit: string; source: string }> = [];
  let recipeVolume = dish.recipeVolume;
  let serving = dish.serving || 280;

  if (dish.recipeId) {
    // Look up v2 recipe
    const recipe = (S.recipes || []).find(r => r.id === dish.recipeId);
    if (!recipe || !recipe.recipeVolume) return [];
    recipeVolume = recipe.recipeVolume;
    serving = recipe.servingSize || serving;
    ingredients = recipe.ingredients.map(ing => {
      let name = ing.ingredientName || ing.flexLabel || '';
      if (!name && ing.ingredientId) {
        const dbIng = (S.ingredientDb || []).find(i => i.id === ing.ingredientId);
        if (dbIng) name = dbIng.name;
      }
      return { name: name || '(unnamed)', amount: ing.rawAmount, unit: ing.unit || 'Grams', source: '' };
    });
  } else if (dish.recipeIngredients && dish.recipeVolume) {
    // Legacy denormalized ingredients (no recipeId)
    ingredients = dish.recipeIngredients.map((ing: RecipeIngredient) => ({
      name: ing.name, amount: ing.amount, unit: ing.unit || 'g', source: ing.source || '',
    }));
  }

  if (ingredients.length === 0 || !recipeVolume) return [];
  const totalGuests = calcTotalGuests(dish);
  if (totalGuests === 0) return [];
  // recipeVolume is in liters (e.g. 10.78), serving is in ml (e.g. 240)
  // Convert recipe volume to ml to match serving size units
  const recipeVolumeMl = recipeVolume * 1000;
  const guestsPerRecipe = recipeVolumeMl / serving;
  const mult = totalGuests / guestsPerRecipe;
  return ingredients.map(ing => ({
    name: ing.name,
    amount: Math.round(ing.amount * mult),
    unit: ing.unit,
    source: ing.source,
  }));
}

export function diffStr(d: Batch): { diff: number; str: string; cls: string } {
  const req = calcRequired(d);
  const diff = Math.round((d.stock - req) * 10) / 10;
  return { diff, str: (diff >= 0 ? '+' : '') + diff + 'L', cls: diff < 0 ? 'stock-miss' : diff < 5 ? 'stock-low' : 'stock-ok' };
}

const STORAGE_BADGE_MAP: Record<string, string> = { Gastro:'b-gastro', Frozen:'b-frozen', 'Vac-packed':'b-vacpack' };

export function storageBadge(s: StorageType | string): string {
  return `<span class="badge ${STORAGE_BADGE_MAP[s] || 'b-gastro'}">${s}</span>`;
}
export function storageBadgeClass(s: StorageType | string): string {
  return 'badge ' + (STORAGE_BADGE_MAP[s] || 'b-gastro');
}
export function cycleStorage(id: string): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;
  const idx = STORAGE.indexOf(d.storage || 'Gastro');
  d.storage = STORAGE[(idx + 1) % STORAGE.length];
  scheduleSave();
  rerenderCurrentView();
}
export function logisticsBadge(d: Batch): string {
  const loc = d.location || 'west';
  const label = loc === 'centraal' ? 'Sering Centraal' : 'Sering West';
  if (d.inTransit) {
    const cls = loc === 'centraal' ? 'b-twc' : 'b-tww';
    return `<span class="badge ${cls}">&rarr; ${label}</span>`;
  }
  return `<span class="badge ${loc === 'centraal' ? 'b-centraal' : 'b-west'}">${label}</span>`;
}
export function logisticsBadgeClass(d: Batch): string {
  const loc = d.location || 'west';
  if (d.inTransit) return 'badge ' + (loc === 'centraal' ? 'b-twc' : 'b-tww');
  return 'badge ' + (loc === 'centraal' ? 'b-centraal' : 'b-west');
}
export function logisticsShort(d: Batch): string {
  const loc = d.location || 'west';
  const label = loc === 'centraal' ? 'Sering Centraal' : 'Sering West';
  if (d.inTransit) return '\u2192 ' + label;
  return label;
}
export function cycleLocation(id: string): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;
  if (d.location === 'west') d.location = 'centraal';
  else d.location = 'west';
  d.inTransit = false;
  rebuildPlanner();
  scheduleSave();
  rerenderCurrentView();
}

// ── SERVED / ARCHIVE ─────────────────────────────────────
export function openServedDialog(id: string): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;
  showModal(`<h3>Mark "${esc(d.name)}" as served</h3>
    <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">This will remove it from the menu planner. Optionally rate it first:</p>
    <div class="fr"><label>Skill required (1-5)</label>
      <div class="rating-row" id="rate-skill">${ratingButtons('skill',0)}</div>
    </div>
    <div class="fr"><label>Speed of prep (1-5)</label>
      <div class="rating-row" id="rate-speed">${ratingButtons('speed',0)}</div>
    </div>
    <div class="fr"><label>Banger rating (1-5)</label>
      <div class="rating-row" id="rate-banger">${ratingButtons('banger',0)}</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="archiveDish('${d.id}',false)">Skip rating</button>
      <button class="btn btn-primary" onclick="archiveDish('${d.id}',true)">Save &amp; archive</button>
    </div>`);
}

export let pendingRatings: BatchRatings = { skill:0, speed:0, banger:0 };

export function ratingButtons(key: keyof BatchRatings, val: number): string {
  pendingRatings[key] = val;
  return [1,2,3,4,5].map(n =>
    `<button class="rating-btn${n <= val ? ' on' : ''}" onclick="setRating('${key}',${n})">${n}</button>`
  ).join('');
}

export function setRating(key: keyof BatchRatings, val: number): void {
  pendingRatings[key] = val;
  const el = document.getElementById('rate-'+key);
  if (el) el.innerHTML = ratingButtons(key, val);
}

export function archiveDish(id: string, withRating: boolean): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;
  const rating = withRating ? { ...pendingRatings } : null;
  // Store in archive (in state for now)
  if (!S.archive) S.archive = [];
  S.archive.push({
    id: d.id,
    name: d.name,
    recipeSheetId: d.recipeSheetId || null,
    type: d.type,
    cookedDate: d.cookDate || null,
    archivedDate: dateToStr(getToday()),
    rating,
  });
  // Update recipe ratings (v2 recipe or legacy recipe index)
  if (rating && d.recipeId) {
    const recipe = (S.recipes || []).find(r => r.id === d.recipeId);
    if (recipe) {
      const n = recipe.timesServed || 0;
      const newN = n + 1;
      recipe.avgSkill = ((recipe.avgSkill || 0) * n + (rating.skill || 0)) / newN;
      recipe.avgSpeed = ((recipe.avgSpeed || 0) * n + (rating.speed || 0)) / newN;
      recipe.avgBanger = ((recipe.avgBanger || 0) * n + (rating.banger || 0)) / newN;
      recipe.timesServed = newN;
      apiPost(`/api/recipes/${recipe.id}`, { avgSkill: recipe.avgSkill, avgSpeed: recipe.avgSpeed, avgBanger: recipe.avgBanger, timesServed: recipe.timesServed }, 'PATCH')
        .catch((e: unknown) => console.error('Failed to update recipe ratings:', e));
    }
  } else if (rating && d.recipeSheetId) {
    const ri = S.recipeIndex.find((r: RecipeEntry) => r.recipeSheetId === d.recipeSheetId);
    if (ri) {
      const n = ri.timesServed || 0;
      const newN = n + 1;
      ri.avgSkill = ((ri.avgSkill || 0) * n + (rating.skill || 0)) / newN;
      ri.avgSpeed = ((ri.avgSpeed || 0) * n + (rating.speed || 0)) / newN;
      ri.avgBanger = ((ri.avgBanger || 0) * n + (rating.banger || 0)) / newN;
      ri.timesServed = newN;
      apiPost('/api/recipe-index', ri).catch((e: unknown) => console.error('Failed to update recipe ratings:', e));
    }
  }
  // Remove from active dishes
  S.batches = S.batches.filter((x: Batch) => x.id !== id);
  pendingRatings = { skill:0, speed:0, banger:0 };
  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
  scheduleSave();
  toast(esc(d.name) + ' archived');
}
export function typeBadge(t: DishType | string): string {
  if (t === 'Dessert') return `<span class="badge b-dessert">Dessert</span>`;
  return `<span class="badge ${t === 'Soup' ? 'b-soup' : 'b-main'}">${t}</span>`;
}
export function typeBadgeClass(t: DishType | string): string {
  if (t === 'Dessert') return 'badge b-dessert';
  return 'badge ' + (t === 'Soup' ? 'b-soup' : 'b-main');
}
export const TYPES: DishType[] = ['Soup','Main course','Dessert'];
export function cycleType(id: string): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;
  const idx = TYPES.indexOf(d.type || 'Soup');
  d.type = TYPES[(idx + 1) % TYPES.length];
  scheduleSave();
  rerenderCurrentView();
}
export function toggleOrder(id: string): void {
  const d = S.batches.find((x: Batch) => x.id === id);
  if (!d) return;
  d.orderFor = !d.orderFor;
  scheduleSave();
  rerenderCurrentView();
}
export function chipClass(d: Batch): string {
  if (d.inTransit) return 'chip-tr';
  if (d.type === 'Soup') return 'chip-soup';
  if (d.type === 'Dessert') return 'chip-dessert';
  return 'chip-main';
}

// ── Date utilities (defined here to avoid circular deps with dishes.ts) ──

export function getToday(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function dateToStr(d: Date): string {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return dd+'/'+mm+'/'+yyyy;
}

export function strToDate(s: string): Date | null {
  if (!s) return null;
  // handle dd/mm/yyyy
  const parts = s.split('/');
  if (parts.length === 3) return new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
  // handle yyyy-mm-dd (legacy)
  return new Date(s);
}

// ═══════════════════════════════════════════════════════════════════
