// CORE LOGIC
// ═══════════════════════════════════════════════════════════════════

import { S, DAYS, MEALS, STORAGE } from './state';
import type { Batch, Service, Catering, CateringDish, RecipeIngredient, Location, Meal, DishType, StorageType, BatchRatings } from '@shared/types';
import { scheduleSave, apiPost, toast } from './utils';
import { showModal, closeModal, esc } from './modal';
import { rerenderCurrentView } from './navigate';
import { renderBatchTile, renderFamilyGrouped } from './dishes';
import { locName } from '@shared/location';

export function isBatchCooked(d: Batch): boolean {
  return (d.stock || 0) > 0;
}

// ── Batch family (parent + splits) ─────────────────────────────────────────
//
// When a cook splits a batch (Tomato Soup West → ships half to Centraal),
// the ship-off becomes a new batch with `parentId` pointing to the original.
// All members share the same recipe, and from a guest's menu point of view
// they're a single option. Family helpers let the algorithm treat them as
// one logical unit (count as 1 menu option, share stock for capacity checks)
// while keeping per-physical-batch tracking for logistics.
//
// Splits are 1-level deep today — each child's parentId points directly to
// the root. The helpers walk the chain anyway, so future deeper splits
// would still work.

/** Returns the root batch id of `b`'s family (or `b.id` if `b` has no parent).
 *
 *  Cycle-safe: tracks visited ids and bails the moment a cycle is detected.
 *  Without that, two members of a hypothetical A→B→A cycle would return
 *  different "roots" depending on parity of the iteration, and family
 *  grouping/`alreadyInSlot` would silently fall apart. On cycle, returns the
 *  lexicographically smallest id touched so the choice is deterministic. */
export function getRootId(b: Batch, allBatches: Batch[]): string {
  const visited = new Set<string>();
  let cur = b;
  while (cur.parentId && !visited.has(cur.id)) {
    visited.add(cur.id);
    const parent = allBatches.find(x => x.id === cur.parentId);
    if (!parent) break;
    cur = parent;
  }
  if (cur.parentId && visited.has(cur.id)) {
    // Cycle detected — pick the smallest id from the loop for stability.
    return [...visited, cur.id].sort()[0];
  }
  return cur.id;
}

/** Returns all batches in `b`'s family (including `b` itself). */
export function getFamilyMembers(b: Batch, allBatches: Batch[]): Batch[] {
  const rootId = getRootId(b, allBatches);
  return allBatches.filter(x => getRootId(x, allBatches) === rootId);
}

/** Sum of stock across the whole family. */
export function getFamilyStock(b: Batch, allBatches: Batch[]): number {
  return getFamilyMembers(b, allBatches).reduce((sum, x) => sum + (x.stock || 0), 0);
}

// ── Family consolidation ───────────────────────────────────────────────────
//
// When a cook ships portions of a recipe between locations multiple times
// (or marks transit batches arrived one-by-one), the DB ends up with N
// physical records of the SAME recipe at the SAME location. Example real
// case from prod: Miso & ginger soup at Centraal as 3 separate splits of
// 12.1L + 12.6L + 18L. From a kitchen perspective that's one 42.7L pot.
//
// Beyond the visual mess, leaving them as 3 records breaks demand math:
//   - calcRequired counts peers per slot. With 3 Miso splits + Tomato at one
//     slot, peers=4 → demand divided by 4 instead of by 2 (Miso family +
//     Tomato family = 2 distinct menu options).
//   - Pass 4 over-fills slots because the per-batch capacity check uses
//     the inflated peer count.
//
// `consolidateFamilies` merges any group of batches that share:
//   - same family root (parentId chain)
//   - same physical location
//   - same storage type (Frozen vs Gastro must NOT merge)
//   - same inTransit flag (in-transit vs arrived must stay separate so a
//     pending arrival doesn't get folded into stock that's actually here)
// Stocks sum, services union (de-duped by slot key), oldest cookDate wins,
// the parent (or smallest id) becomes the survivor. Removed batches go into
// the deletedBatches list so the patch endpoint cleans them server-side.

export interface ConsolidationResult {
  /** The deduplicated batch list — caller should replace S.batches with this. */
  kept: Batch[];
  /** IDs that should be appended to S.deletedBatches and saved. */
  removed: string[];
  /** Diagnostic count of merges performed. */
  mergedGroups: number;
}

export function consolidateFamilies(batches: Batch[]): ConsolidationResult {
  const removed: string[] = [];
  let mergedGroups = 0;

  // Bucket by (familyRoot, location, storage, inTransit). Anything in the
  // same bucket is a merge candidate.
  const buckets = new Map<string, Batch[]>();
  for (const b of batches) {
    const root = getRootId(b, batches);
    const key = `${root}|${b.location}|${b.storage}|${b.inTransit ? 't' : 'f'}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(b);
  }

  // Track survivors so we can rebuild the list at the end.
  const survivorIds = new Set<string>();
  const updatedById = new Map<string, Batch>();

  for (const [, group] of buckets) {
    if (group.length === 1) {
      survivorIds.add(group[0].id);
      continue;
    }
    mergedGroups++;
    const primary = pickPrimary(group);
    const others = group.filter(b => b.id !== primary.id);

    // Sum stocks
    primary.stock = round1(group.reduce((s, b) => s + (b.stock || 0), 0));

    // Union services (de-duped by slot key); also pull in any "extras" the
    // primary missed.
    const seen = new Set<string>(
      (primary.services || []).map(s => `${s.loc}|${s.date}|${s.meal}`),
    );
    for (const o of others) {
      for (const svc of o.services || []) {
        const k = `${svc.loc}|${svc.date}|${svc.meal}`;
        if (!seen.has(k)) {
          primary.services.push(svc);
          seen.add(k);
        }
      }
    }

    // Use the OLDEST cookDate (use up older food first — same heuristic the
    // assigner uses).
    const cookDates = group.map(b => b.cookDate).filter((d): d is string => !!d);
    if (cookDates.length > 0) {
      primary.cookDate = cookDates.sort((a, b) => {
        // dd/mm/yyyy → yyyy-mm-dd for lexicographic compare
        const aIso = a.split('/').reverse().join('-');
        const bIso = b.split('/').reverse().join('-');
        return aIso.localeCompare(bIso);
      })[0];
    }

    // Merge notes (concat unique non-empty)
    const notes = group.map(b => b.note?.trim()).filter((n): n is string => !!n);
    if (notes.length > 0) primary.note = Array.from(new Set(notes)).join(' / ');

    // Allergens — union of any extras from siblings
    const allerg = new Set<string>(primary.allergens || []);
    const xtra = new Set<string>(primary.extraAllergens || []);
    for (const o of others) {
      for (const a of o.allergens || []) allerg.add(a);
      for (const a of o.extraAllergens || []) xtra.add(a);
    }
    primary.allergens = Array.from(allerg);
    primary.extraAllergens = Array.from(xtra);

    survivorIds.add(primary.id);
    updatedById.set(primary.id, primary);
    for (const o of others) removed.push(o.id);
  }

  // Re-fixup parentId references: if a batch's parentId pointed to one of
  // the removed records, redirect it to that group's primary so the family
  // chain stays intact.
  const redirectMap = new Map<string, string>();
  for (const [, group] of buckets) {
    if (group.length < 2) continue;
    const primary = pickPrimary(group);
    for (const o of group) {
      if (o.id !== primary.id) redirectMap.set(o.id, primary.id);
    }
  }
  const kept = batches.filter(b => survivorIds.has(b.id));
  for (const b of kept) {
    if (b.parentId && redirectMap.has(b.parentId)) {
      b.parentId = redirectMap.get(b.parentId)!;
    }
    // If parent points to self after redirect (i.e. survivor is now its own
    // root), null the parentId.
    if (b.parentId === b.id) b.parentId = null;
  }

  return { kept, removed, mergedGroups };
}

function pickPrimary(group: Batch[]): Batch {
  // Parent (no parentId) takes priority — most stable identity.
  const parent = group.find(b => !b.parentId);
  if (parent) return parent;
  // Otherwise: oldest cookDate, tiebreak smallest id.
  return [...group].sort((a, b) => {
    const ad = a.cookDate ? a.cookDate.split('/').reverse().join('-') : '';
    const bd = b.cookDate ? b.cookDate.split('/').reverse().join('-') : '';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.id.localeCompare(b.id);
  })[0];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
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

// Convert a JS Date object to ISO date string "2026-03-23".
// Delegates to @shared/dates#formatIso — single source of truth.
// `import as` + `export` (not pure `export { X } from 'foo'`) so the
// alias is in the local scope; later code in this file calls `dateToIso(...)`.
import { formatIso as dateToIso } from '@shared/dates';
export { dateToIso };

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
    // renderFamilyGrouped (defined in dishes.ts) wraps split families in a
    // .batch-family-card with per-location sections + same-loc merging +
    // arrived-vs-in-transit split. Single-member families render bare.
    // Single source of truth for family-aware tile rendering.
    html += renderFamilyGrouped(uncooked);
  }
  if (cooked.length > 0) {
    html += `<div class="cook-group-hdr cooked-hdr">Cooked (${cooked.length})</div>`;
    html += renderFamilyGrouped(cooked);
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

  // Fall back to predicted counts (from POS history) before base counts —
  // base counts hold the current week's day-of-week values, which would
  // return 0 for a future Monday if this Monday already passed.
  if (S.predictions && S.predictions[lk] && S.predictions[lk][dn] && S.predictions[lk][dn][meal] !== undefined) {
    return S.predictions[lk][dn][meal];
  }

  // Final fallback to base counts
  return ((S.guests[lk] || {})[dn] || {} as any)[meal] || 0;
}

/**
 * Family-aware demand share at a slot.
 *
 * Slot demand splits across menu OPTIONS (= families), not raw batches —
 * guests see one Tomato Soup, not two, regardless of how many physical pots
 * the family owns. Within a family at the slot, the family's share splits
 * STOCK-PROPORTIONALLY across its physical members:
 *
 *   member's share = family_share × (myStock / totalFamilyStockAtSlot)
 *
 * Daan's intuition: "if I have 20L at Centraal and 50L at West and the slot
 * needs 30L, the small batch shouldn't go negative while the big one has
 * surplus." With even split (old behaviour), a Centraal split (20L) and a
 * West parent (50L) would each be charged 9L per slot, so 3 slots = 27L for
 * the split → over-stocked. Stock-proportional gives the split 5.7L per
 * slot (3 slots = 17L, well under 20L), parent picks up the rest.
 *
 * Edge case: if every family member at the slot has 0 stock (all uncooked
 * placeholders, an unusual but possible config) we fall back to even split
 * so the placeholder still surfaces a "to be cooked" volume.
 *
 * Returns { perBatch, families }: `perBatch` is what THIS dish should be
 * charged at this slot, `families` is the menu-option count (used for
 * breakdown text).
 */
function familyAwareSlotDemand(dish: Batch, svc: Service): { perBatch: number; families: number } {
  const g = getGuests(svc.loc, svc.date, svc.meal);
  if (g <= 0) return { perBatch: 0, families: 0 };
  const k = `${svc.loc}-${svc.date}-${svc.meal}`;
  const peers = (S.planner[k] || []).filter((d: Batch) => d.type === dish.type);
  const familyRoots = new Set<string>();
  for (const p of peers) familyRoots.add(getRootId(p, S.batches));
  const families = Math.max(familyRoots.size, 1);
  const myRoot = getRootId(dish, S.batches);
  const familyMembersAtSlot = peers.filter(p => getRootId(p, S.batches) === myRoot);
  const familyShare = (g / families) * ((dish.serving || 280) / 1000);
  const totalStock = familyMembersAtSlot.reduce((s, m) => s + (m.stock || 0), 0);
  if (totalStock <= 0) {
    // All-zero family (e.g. uncooked placeholders only) — fall back to even
    // split so each surfaces a "to be cooked" demand.
    const count = Math.max(familyMembersAtSlot.length, 1);
    return { perBatch: familyShare / count, families };
  }
  const myShare = familyShare * ((dish.stock || 0) / totalStock);
  return { perBatch: myShare, families };
}

export function calcRequired(dish: Batch): number {
  let total = 0;
  (dish.services || []).forEach((svc: Service) => {
    if (isServicePast(svc)) return; // Skip served services — no longer pulling stock
    total += familyAwareSlotDemand(dish, svc).perBatch;
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
    const loc = locName(svc.loc);
    const meal = svc.meal.charAt(0).toUpperCase() + svc.meal.slice(1);
    const dayName = dateToDayName(svc.date);
    // Past services show as "served" instead of contributing liters
    if (isServicePast(svc)) {
      lines.push(`\u2713 ${dayName} ${meal} ${loc} (served)`);
      return;
    }
    const { perBatch } = familyAwareSlotDemand(dish, svc);
    const liters = Math.round(perBatch * 10) / 10;
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
    // Same family-aware split as calcRequired (see familyAwareSlotDemand) —
    // STOCK-PROPORTIONAL within the family, falls back to even split when
    // the family is all-zero stock (uncooked placeholders).
    const familyRoots = new Set<string>();
    for (const p of peers) familyRoots.add(getRootId(p, S.batches));
    const families = Math.max(familyRoots.size, 1);
    const myRoot = getRootId(dish, S.batches);
    const familyAtSlot = peers.filter(p => getRootId(p, S.batches) === myRoot);
    const totalFamilyStock = familyAtSlot.reduce((s, m) => s + (m.stock || 0), 0);
    if (totalFamilyStock <= 0) {
      const count = Math.max(familyAtSlot.length, 1);
      g += total / families / count;
    } else {
      g += (total / families) * ((dish.stock || 0) / totalFamilyStock);
    }
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
  // The batch effectively "arrived" at a new location — fold it into any
  // existing same-family same-loc record so cooks don't end up with
  // duplicates of the same recipe at one place.
  const consolidation = consolidateFamilies(S.batches);
  if (consolidation.removed.length > 0) {
    S.batches = consolidation.kept;
    if (!S.deletedBatches) S.deletedBatches = [];
    for (const id of consolidation.removed) S.deletedBatches.push(id);
  }
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
  }
  // Legacy v1: rating updates by recipeSheetId used to write to /api/recipe-index.
  // The endpoint and S.recipeIndex were removed in S12 (the writes never came
  // back to the frontend, so ratings on Sheet-only batches disappeared on
  // every reload). v2 ratings above are the supported path.
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
