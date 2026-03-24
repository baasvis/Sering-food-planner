// CORE LOGIC
// ═══════════════════════════════════════════════════════════════════

// ── Choppable ingredient detection ──────────────────────
// Categories from ingredient DB that need chopping/prep
const CHOPPABLE_CATEGORIES = [
  'vegetables & fruit',       // production DB
  'herbs & spices',           // fresh herbs (dried spices caught by PANTRY_KEYWORDS)
  'vegetables', 'fruits', 'mushrooms', 'herbs', 'beans and legumes',  // seed DB fallback
];

// Fallback keywords for ingredients not found in DB — these are NOT choppable
// NOTE: fresh herbs removed (parsley, basil, cilantro, thyme, rosemary) — herbs ARE choppable
const PANTRY_KEYWORDS = [
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
];

// Build a lookup cache from ingredient DB (name/supplierName → category)
let _ingredientCategoryCache = null;
function getIngredientCategoryCache() {
  if (_ingredientCategoryCache && _ingredientCategoryCache.size > 0) return _ingredientCategoryCache;
  _ingredientCategoryCache = new Map();
  (S.ingredientDb || []).forEach(ing => {
    const cat = (ing.category || '').toLowerCase().trim();
    if (!cat) return;
    if (ing.name) _ingredientCategoryCache.set(ing.name.toLowerCase().trim(), cat);
    if (ing.supplierName) _ingredientCategoryCache.set(ing.supplierName.toLowerCase().trim(), cat);
  });
  return _ingredientCategoryCache;
}

function isChoppableIngredient(name) {
  const lower = name.toLowerCase().trim();
  // Hard exclusion: pantry staples are never choppable regardless of DB category
  if (PANTRY_KEYWORDS.some(kw => lower.includes(kw))) return false;
  // Check ingredient DB categories
  const cache = getIngredientCategoryCache();
  // Exact match
  const exact = cache.get(lower);
  if (exact) return CHOPPABLE_CATEGORIES.includes(exact);
  // Word-level fuzzy: "red onion" contains word "onion", "carrot (purple)" contains "carrot"
  const wordBoundary = (haystack, needle) => {
    const i = haystack.indexOf(needle);
    if (i === -1) return false;
    const before = i === 0 || /\W/.test(haystack[i - 1]);
    const after = i + needle.length >= haystack.length || /\W/.test(haystack[i + needle.length]);
    return before && after;
  };
  const matchedCats = [];
  for (const [dbName, cat] of cache) {
    if (dbName === lower) continue;
    if (wordBoundary(dbName, lower) || wordBoundary(lower, dbName)) {
      matchedCats.push(cat);
    }
  }
  if (matchedCats.length > 0) {
    return matchedCats.some(cat => CHOPPABLE_CATEGORIES.includes(cat));
  }
  // Not found in DB and not a pantry keyword — include it
  return true;
}

// ── Core helpers ────────────────────────────────────────

function isBatchCooked(d) {
  return (d.stock || 0) > 0;
}

function locationBadge(d) {
  if (d.location === 'centraal') {
    return `<span class="badge b-centraal">Sering Centraal</span>`;
  }
  return `<span class="badge b-west">Sering West</span>`;
}

// Amsterdam time helper (shared — also used by planner.js inventory)
function getAmsterdamNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
}

// Convert a date string ("2026-03-23") to a day name ("Mon", "Tue", etc.)
function dateToDayName(dateStr) {
  const d = new Date(dateStr + 'T12:00:00'); // noon to avoid timezone edge cases
  return DAYS[(d.getDay() + 6) % 7];
}

// Convert a JS Date object to ISO date string "2026-03-23"
function dateToIso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Check if a service is past / "served".
// Services store date as ISO string (e.g., "2026-03-23").
// A service is served when:
// - Its date is before today, OR
// - Its date is today AND (clock past deadline OR inventory done after urgent)
function isServicePast(svc) {
  const now = getAmsterdamNow();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const svcDate = new Date(svc.date + 'T12:00:00');
  const svcDay = new Date(svcDate.getFullYear(), svcDate.getMonth(), svcDate.getDate());
  if (svcDay < today) return true;       // past date
  if (svcDay > today) return false;      // future date
  // Today — check time and inventory state
  const mins = now.getHours() * 60 + now.getMinutes();
  const lk = svc.loc === 'west' ? 'west' : 'centraal';
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

function rebuildPlanner() {
  S.planner = {};
  S.batches.forEach(d => {
    (d.services || []).forEach(svc => {
      const k = `${svc.loc}-${svc.date}-${svc.meal}`;
      if (!S.planner[k]) S.planner[k] = [];
      if (!S.planner[k].find(x => x.id === d.id)) S.planner[k].push(d);
    });
  });
}

function renderDishListSplit(dishes) {
  const cooked = sortByCookDate(dishes.filter(d => isBatchCooked(d)));
  const uncooked = sortByCookDate(dishes.filter(d => !isBatchCooked(d)));
  let html = '';
  if (uncooked.length > 0) {
    html += `<div class="cook-group-hdr uncooked-hdr">To cook (${uncooked.length})</div>`;
    uncooked.forEach(d => { html += renderBatchTile(d); });
  }
  if (cooked.length > 0) {
    html += `<div class="cook-group-hdr cooked-hdr">Cooked (${cooked.length})</div>`;
    cooked.forEach(d => { html += renderBatchTile(d); });
  }
  return html;
}

function sortByCookDate(dishes) {
  return [...dishes].sort((a, b) => {
    const da = a.cookDate ? strToDate(a.cookDate) : null;
    const db = b.cookDate ? strToDate(b.cookDate) : null;
    // No date goes to bottom
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  });
}

// Get guest count for a location, date string, and meal
function getGuests(loc, dateStr, meal) {
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
    return ((S.guests[lk] || {})[dn] || {})[meal] || 0;
  }

  // Future/past weeks: use guestsNextWeeks predictions
  const weekData = S.guestsNextWeeks[mk];
  if (weekData && weekData[lk] && weekData[lk][dn] && weekData[lk][dn][meal] !== undefined) {
    return weekData[lk][dn][meal];
  }

  // Final fallback to base counts
  return ((S.guests[lk] || {})[dn] || {})[meal] || 0;
}

// Shared core: calculates liters per service/catering for a dish
// Returns { total, parts } where parts is an array of { liters, label } objects
function _calcRequiredParts(dish) {
  let total = 0;
  const parts = [];
  const servingL = (dish.serving || 280) / 1000;

  (dish.services || []).forEach(svc => {
    const loc = svc.loc === 'west' ? 'Sering West' : 'Sering Centraal';
    const meal = svc.meal.charAt(0).toUpperCase() + svc.meal.slice(1);
    const dayName = dateToDayName(svc.date);

    if (isServicePast(svc)) {
      parts.push({ liters: 0, label: `✓ ${dayName} ${meal} ${loc} (served)`, served: true });
      return;
    }
    const g = getGuests(svc.loc, svc.date, svc.meal);
    const k = `${svc.loc}-${svc.date}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
    const liters = Math.round((g / Math.max(peers.length, 1)) * servingL * 10) / 10;
    total += liters;
    if (liters > 0) parts.push({ liters, label: `${liters}L — ${dayName} ${meal} ${loc}` });
  });

  (S.caterings || []).forEach(c => {
    const cd = (c.dishes || []).find(cd => cd.dishId === dish.id);
    if (cd) {
      const peers = (c.dishes || []).filter(d => d.type === dish.type).length;
      const liters = Math.round(((c.guestCount || 0) / Math.max(peers, 1)) * servingL * 10) / 10;
      total += liters;
      if (liters > 0) parts.push({ liters, label: `${liters}L — ${c.name} (${c.guestCount} guests${peers > 1 ? ', 1/' + peers + ' split' : ''})` });
    }
  });

  return { total: Math.round(total * 10) / 10, parts };
}

function calcRequired(dish) {
  return _calcRequiredParts(dish).total;
}

function calcRequiredBreakdown(dish) {
  return _calcRequiredParts(dish).parts.map(p => p.label);
}

function calcTotalGuests(dish) {
  let g = 0;
  (dish.services || []).forEach(svc => {
    if (isServicePast(svc)) return; // Skip served services
    const total = getGuests(svc.loc, svc.date, svc.meal);
    const k = `${svc.loc}-${svc.date}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
    g += total / Math.max(peers.length, 1);
  });
  // Add catering guests (split by same-type peers)
  (S.caterings || []).forEach(c => {
    const cd = (c.dishes || []).find(cd => cd.dishId === dish.id);
    if (cd) {
      const peers = (c.dishes || []).filter(d => d.type === dish.type).length;
      g += (c.guestCount || 0) / Math.max(peers, 1);
    }
  });
  return Math.round(g);
}

function calcIngredientsFromRecipe(dish) {
  if (!dish.recipeIngredients || !dish.recipeVolume) return [];
  const totalGuests = calcTotalGuests(dish);
  if (totalGuests === 0) return [];
  // recipeVolume is in liters (e.g. 10.78), serving is in ml (e.g. 240)
  // Convert recipe volume to ml to match serving size units
  const recipeVolumeMl = dish.recipeVolume * 1000;
  const guestsPerRecipe = recipeVolumeMl / (dish.serving || 280);
  const mult = totalGuests / guestsPerRecipe;
  return dish.recipeIngredients.map(ing => ({
    name: ing.name,
    amount: Math.round(ing.amount * mult),
    unit: ing.unit || 'g',
    source: ing.source || '',
  }));
}

function diffStr(d) {
  const req = calcRequired(d);
  const diff = Math.round((d.stock - req) * 10) / 10;
  return { diff, str: (diff >= 0 ? '+' : '') + diff + 'L', cls: diff < 0 ? 'stock-miss' : diff < 5 ? 'stock-low' : 'stock-ok' };
}

function storageBadge(s) {
  const m = { Gastro:'b-gastro', Frozen:'b-frozen', 'Vac-packed':'b-vacpack' };
  return `<span class="badge ${m[s] || 'b-gastro'}">${s}</span>`;
}
function storageBadgeClass(s) {
  const m = { Gastro:'b-gastro', Frozen:'b-frozen', 'Vac-packed':'b-vacpack' };
  return 'badge ' + (m[s] || 'b-gastro');
}
function cycleStorage(id) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const idx = STORAGE.indexOf(d.storage || 'Gastro');
  d.storage = STORAGE[(idx + 1) % STORAGE.length];
  scheduleSave();
  rerenderCurrentView();
}
function logisticsBadge(d) {
  const loc = d.location || 'west';
  const label = loc === 'centraal' ? 'Sering Centraal' : 'Sering West';
  if (d.inTransit) {
    const cls = loc === 'centraal' ? 'b-twc' : 'b-tww';
    return `<span class="badge ${cls}">&rarr; ${label}</span>`;
  }
  return `<span class="badge ${loc === 'centraal' ? 'b-centraal' : 'b-west'}">${label}</span>`;
}
function logisticsBadgeClass(d) {
  const loc = d.location || 'west';
  if (d.inTransit) return 'badge ' + (loc === 'centraal' ? 'b-twc' : 'b-tww');
  return 'badge ' + (loc === 'centraal' ? 'b-centraal' : 'b-west');
}
function logisticsShort(d) {
  const loc = d.location || 'west';
  const label = loc === 'centraal' ? 'Sering Centraal' : 'Sering West';
  if (d.inTransit) return '\u2192 ' + label;
  return label;
}
function cycleLocation(id) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  if (d.location === 'west') d.location = 'centraal';
  else d.location = 'west';
  d.inTransit = false;
  rebuildPlanner();
  scheduleSave();
  rerenderCurrentView();
}

// ── SERVED / ARCHIVE ─────────────────────────────────────
function openServedDialog(id) {
  const d = S.batches.find(x => x.id === id);
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

let pendingRatings = { skill:0, speed:0, banger:0 };

function ratingButtons(key, val) {
  pendingRatings[key] = val;
  return [1,2,3,4,5].map(n =>
    `<button class="rating-btn${n <= val ? ' on' : ''}" onclick="setRating('${key}',${n})">${n}</button>`
  ).join('');
}

function setRating(key, val) {
  pendingRatings[key] = val;
  document.getElementById('rate-'+key).innerHTML = ratingButtons(key, val);
}

function archiveDish(id, withRating) {
  const d = S.batches.find(x => x.id === id);
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
  // Update recipe index with running average of ratings
  if (rating && d.recipeSheetId) {
    const ri = S.recipeIndex.find(r => r.recipeSheetId === d.recipeSheetId);
    if (ri) {
      const n = ri.timesServed || 0;
      const newN = n + 1;
      ri.avgSkill = ((ri.avgSkill || 0) * n + (rating.skill || 0)) / newN;
      ri.avgSpeed = ((ri.avgSpeed || 0) * n + (rating.speed || 0)) / newN;
      ri.avgBanger = ((ri.avgBanger || 0) * n + (rating.banger || 0)) / newN;
      ri.timesServed = newN;
      // Save updated recipe index entry
      apiPost('/api/recipe-index', ri).catch(e => console.error('Failed to update recipe ratings:', e));
    }
  }
  // Remove from active dishes
  S.batches = S.batches.filter(x => x.id !== id);
  pendingRatings = { skill:0, speed:0, banger:0 };
  closeModal();
  rebuildPlanner();
  rerenderCurrentView();
  scheduleSave();
  toast(esc(d.name) + ' archived');
}
function typeBadge(t) {
  if (t === 'Dessert') return `<span class="badge b-dessert">Dessert</span>`;
  return `<span class="badge ${t === 'Soup' ? 'b-soup' : 'b-main'}">${t}</span>`;
}
function typeBadgeClass(t) {
  if (t === 'Dessert') return 'badge b-dessert';
  return 'badge ' + (t === 'Soup' ? 'b-soup' : 'b-main');
}
const TYPES = ['Soup','Main course','Dessert'];
function cycleType(id) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  const idx = TYPES.indexOf(d.type || 'Soup');
  d.type = TYPES[(idx + 1) % TYPES.length];
  scheduleSave();
  rerenderCurrentView();
}
function toggleOrder(id) {
  const d = S.batches.find(x => x.id === id);
  if (!d) return;
  d.orderFor = !d.orderFor;
  scheduleSave();
  rerenderCurrentView();
}
function chipClass(d) {
  if (d.inTransit) return 'chip-tr';
  if (d.type === 'Soup') return 'chip-soup';
  if (d.type === 'Dessert') return 'chip-dessert';
  return 'chip-main';
}

// ═══════════════════════════════════════════════════════════════════
