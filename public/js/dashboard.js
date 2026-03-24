// SCREENS
// ═══════════════════════════════════════════════════════════════════

function showScreen(name) {
  // Switch active screen
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  // Sync both navs using data-screen attribute
  document.querySelectorAll('.nav-btn, .bnav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === name);
  });
  // Only rebuild planner data when actually viewing planner or dashboard
  if (name === 'planner' || name === 'dashboard') rebuildPlanner();
  if (name === 'dashboard') renderDashboard();
  if (name === 'guests') renderGuests();
  if (name === 'planner') renderWeekPlan();
  if (name === 'recipe-index') renderRecipeIndex();
  if (name === 'orders') renderOrders();
}

// ── DASHBOARD ────────────────────────────────────────────
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

function isDishAtLocation(dish, loc) {
  return dish.location === loc;
}

function getCookDateDishes(loc, date) {
  const dateStr = dateToStr(date);
  return S.batches.filter(d =>
    d.cookDate === dateStr &&
    !isBatchCooked(d) &&
    isDishAtLocation(d, loc)
  );
}

// Get all unique dishes in the menu for a given location + ISO date string
function getMenuDishes(loc, dateStr) {
  const seen = new Set();
  const dishes = [];
  MEALS.forEach(meal => {
    const k = `${loc}-${dateStr}-${meal}`;
    (S.planner[k] || []).forEach(d => {
      if (!seen.has(d.id)) { seen.add(d.id); dishes.push(d); }
    });
  });
  return dishes;
}

function calcLitersForService(dish, loc, dateStr, meal) {
  const k = `${loc}-${dateStr}-${meal}`;
  const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
  const count = Math.max(peers.length, 1);
  const g = getGuests(loc, dateStr, meal);
  return Math.round((g / count) * ((dish.serving || 280) / 1000) * 10) / 10;
}

function getVegIngredients(dishes) {
  // Returns array of { name, amount, unit }  aggregated across dishes
  const combined = {};
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

// Per-dish starch selector (Rice or Pasta)
function setDishStarch(dishId, starch) {
  const d = S.batches.find(x => x.id === dishId);
  if (!d) return;
  d.starch = (d.starch === starch) ? null : starch;
  scheduleSave();
  renderDashboardContent();
}

// Meal-level starch summary — aggregates all mains in a meal
function starchSummaryHtml(dishes, gc) {
  const mains = dishes.filter(d => d.type === 'Main course' && d.starch);
  if (!mains.length) return '';
  const totals = {};
  mains.forEach(d => {
    const peers = dishes.filter(p => p.type === 'Main course');
    const guestsForDish = Math.round(gc / Math.max(peers.length, 1));
    const kg = parseFloat((Math.round(guestsForDish * 1.2) * 80 / 1000).toFixed(1));
    totals[d.starch] = (totals[d.starch] || 0) + kg;
  });
  const parts = Object.entries(totals).map(([name, kg]) =>
    `<span class="dash-starch-summary-item">${name === 'Rice' ? '🍚' : '🍝'} Cook <strong>${kg} kg</strong> ${name}</span>`
  );
  return `<div class="dash-starch-meal-summary">${parts.join('<span class="dash-starch-sep">+</span>')}</div>`;
}

function renderDashboard() {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const userName = S.user?.name ? ', ' + S.user.name.split(' ')[0] : '';
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const loc = S.dashboardLoc;

  document.getElementById('screen-dashboard').innerHTML = `
    <div class="dash-greeting">${greeting}${esc(userName)}</div>
    <div class="dash-date">${dateStr}</div>
    <div class="dash-tab-bar">
      <button class="dash-tab${loc === 'west' ? ' active' : ''}" onclick="setDashboardLoc('west')">Sering West</button>
      <button class="dash-tab${loc === 'centraal' ? ' active' : ''}" onclick="setDashboardLoc('centraal')">Sering Centraal</button>
    </div>
    <div id="dash-content"></div>
    <div id="dash-team-float" class="dash-team-float"></div>
  `;

  // Load persisted state then render
  loadDayTodos();
  loadPrepChecklist(loc).then(() => { renderDashboardContent(); renderTeamTodos(); });
}

function setDashboardLoc(loc) {
  S.dashboardLoc = loc;
  document.querySelectorAll('.dash-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.dash-tab[onclick="setDashboardLoc('${loc}')"]`).classList.add('active');
  loadPrepChecklist(loc).then(() => { renderDashboardContent(); renderTeamTodos(); });
}

// ── Guest Flow Chart ─────────────────────────────────────
// Shows estimated guest arrivals per 5-minute interval as a line chart.
// Uses a gaussian distribution applied to the expected total guest count.

let _guestFlowMeal = 'lunch'; // current toggle state

function setGuestFlowMeal(meal) {
  _guestFlowMeal = meal;
  document.querySelectorAll('.dash-flow-toggle').forEach(b => b.classList.toggle('active', b.dataset.meal === meal));
  drawGuestFlowChart();
}

// Gaussian bell curve: returns value 0-1 centered at `center` with spread `sigma`
function gaussian(x, center, sigma) {
  return Math.exp(-0.5 * Math.pow((x - center) / sigma, 2));
}

// Build a distribution of guest arrivals per 5-min slot for a meal.
// Returns array of { time: "HH:MM", guests: number }
function buildGuestFlowData(totalGuests, meal) {
  // Service windows (in minutes from midnight)
  const LUNCH = { start: 12 * 60, end: 14 * 60, peak: 12 * 60 + 35, sigma: 22 };
  const DINNER = { start: 18 * 60, end: 21 * 60, peak: 19 * 60 + 10, sigma: 30 };
  const cfg = meal === 'lunch' ? LUNCH : DINNER;

  const slots = [];
  // Generate raw weights
  let totalWeight = 0;
  for (let t = cfg.start; t < cfg.end; t += 5) {
    const w = gaussian(t, cfg.peak, cfg.sigma);
    slots.push({ min: t, weight: w });
    totalWeight += w;
  }

  // Normalize and scale to total guests
  return slots.map(s => {
    const h = Math.floor(s.min / 60);
    const m = s.min % 60;
    return {
      time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      guests: Math.round((s.weight / totalWeight) * totalGuests * 10) / 10
    };
  });
}

function drawGuestFlowChart() {
  const canvas = document.getElementById('guest-flow-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // HiDPI support
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width;
  const h = 180;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const loc = S.dashboardLoc;
  const todayIso = dateToIso(getToday());
  const totalGuests = getGuests(loc, todayIso, _guestFlowMeal);
  const data = buildGuestFlowData(totalGuests, _guestFlowMeal);

  // Detect dark mode
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const textColor = isDark ? '#a0a09a' : '#6b6b66';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const lineColor = _guestFlowMeal === 'lunch' ? (isDark ? '#E4A84D' : '#BA7517') : (isDark ? '#8B82E0' : '#534AB7');
  const fillColor = _guestFlowMeal === 'lunch' ? (isDark ? 'rgba(228,168,77,0.12)' : 'rgba(186,117,23,0.08)') : (isDark ? 'rgba(139,130,224,0.12)' : 'rgba(83,74,183,0.08)');

  // Chart padding
  const pad = { top: 16, right: 16, bottom: 28, left: 36 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  if (totalGuests === 0) {
    ctx.fillStyle = textColor;
    ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No guest data for today', w / 2, h / 2);
    return;
  }

  const maxGuests = Math.max(...data.map(d => d.guests), 1);
  // Round up to nice number for y-axis
  const yMax = Math.ceil(maxGuests / 2) * 2 || 2;

  // X/Y mappers
  const xOf = i => pad.left + (i / (data.length - 1)) * cw;
  const yOf = v => pad.top + ch - (v / yMax) * ch;

  // Grid lines (3 horizontal)
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const yVal = (yMax / 3) * i;
    const y = yOf(yVal);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    // Y labels
    ctx.fillStyle = textColor;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(yVal), pad.left - 6, y + 3);
  }

  // X labels (every 30 minutes)
  ctx.fillStyle = textColor;
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  data.forEach((d, i) => {
    const mins = parseInt(d.time.split(':')[1]);
    if (mins === 0 || mins === 30) {
      ctx.fillText(d.time, xOf(i), h - 6);
    }
  });

  // Fill area under curve
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  data.forEach((d, i) => ctx.lineTo(xOf(i), yOf(d.guests)));
  ctx.lineTo(xOf(data.length - 1), yOf(0));
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // Line
  ctx.beginPath();
  data.forEach((d, i) => {
    if (i === 0) ctx.moveTo(xOf(i), yOf(d.guests));
    else ctx.lineTo(xOf(i), yOf(d.guests));
  });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Current time indicator (vertical line if within service window)
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
    // "Now" label
    ctx.fillStyle = isDark ? '#E86B5A' : '#993C1D';
    ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Now', nowX, pad.top - 4);
  }

  // Peak label
  const peakIdx = data.reduce((best, d, i) => d.guests > data[best].guests ? i : best, 0);
  const peakD = data[peakIdx];
  ctx.fillStyle = lineColor;
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`~${Math.round(peakD.guests)}/5min`, xOf(peakIdx), yOf(peakD.guests) - 8);
}

// ── Day todos (heat/cook checkboxes + custom notes) ───
function _dayTodosKey() { return `sering-todos-${todayIso()}`; }

function loadDayTodos() {
  try {
    const data = JSON.parse(localStorage.getItem(_dayTodosKey()) || '{}');
    S.heatChecked   = new Set(data.heat   || []);
    S.cookChecked   = new Set(data.cook   || []);
    S.customTodos   = data.custom || [];
  } catch(e) {
    S.heatChecked = new Set();
    S.cookChecked = new Set();
    S.customTodos = [];
  }
}

function saveDayTodos() {
  localStorage.setItem(_dayTodosKey(), JSON.stringify({
    heat:   [...S.heatChecked],
    cook:   [...S.cookChecked],
    custom: S.customTodos,
  }));
}

function toggleHeatItem(dishId) {
  S.heatChecked.has(dishId) ? S.heatChecked.delete(dishId) : S.heatChecked.add(dishId);
  saveDayTodos();
  renderDashboardContent();
}

function toggleCookItem(dishId) {
  const d = S.batches.find(x => x.id === dishId);
  if (d && !isBatchCooked(d)) {
    // Actually mark the dish as cooked (same as "click to mark as cooked" on the tile)
    confirmCooked(dishId);
    // Also tick off the local checkbox
    S.cookChecked.add(dishId);
    saveDayTodos();
    renderDashboardContent();
    return;
  }
  // Already cooked or not found — just toggle the local checkbox
  S.cookChecked.has(dishId) ? S.cookChecked.delete(dishId) : S.cookChecked.add(dishId);
  saveDayTodos();
  renderDashboardContent();
}

function addCustomTodo(text) {
  if (!text.trim()) return;
  S.customTodos.push({ id: newId(), text: text.trim(), done: false });
  saveDayTodos();
  renderTeamTodos();
  setTimeout(() => document.getElementById('custom-todo-input')?.focus(), 0);
}

function toggleCustomTodo(id) {
  const t = S.customTodos.find(x => x.id === id);
  if (t) { t.done = !t.done; saveDayTodos(); renderTeamTodos(); }
}

function deleteCustomTodo(id) {
  S.customTodos = S.customTodos.filter(x => x.id !== id);
  saveDayTodos();
  renderTeamTodos();
}

function toggleTeamTodos() {
  S.teamTodosOpen = !S.teamTodosOpen;
  renderTeamTodos();
}

function renderTeamTodos() {
  const el = document.getElementById('dash-team-float');
  if (!el) return;
  const open = S.teamTodosOpen;
  const undone = S.customTodos.filter(t => !t.done).length;
  el.innerHTML = `
    ${open ? `
    <div class="dash-team-panel">
      <div class="dash-custom-input-row">
        <input class="dash-custom-input" id="custom-todo-input" type="text" placeholder="e.g. Clean walk-in fridge..."
          onkeydown="if(event.key==='Enter')addCustomTodo(this.value)">
        <button class="dash-custom-add-btn" onclick="addCustomTodo(document.getElementById('custom-todo-input').value)">Add</button>
      </div>
      ${S.customTodos.length === 0
        ? `<div class="dash-empty">No todos yet — add one above</div>`
        : S.customTodos.map(t => `
          <div class="dash-prep-item${t.done ? ' checked' : ''}" onclick="toggleCustomTodo('${esc(t.id)}')">
            <div class="dash-prep-check">${t.done ? '✓' : ''}</div>
            <span class="dash-prep-name">${esc(t.text)}</span>
            <button class="dash-todo-del" onclick="event.stopPropagation();deleteCustomTodo('${esc(t.id)}')">✕</button>
          </div>`).join('')
      }
    </div>` : ''}
    <button class="dash-team-fab" onclick="toggleTeamTodos()">
      📝 Team Todo's
      ${undone > 0 ? `<span class="dash-team-badge">${undone}</span>` : ''}
    </button>
  `;
  if (open) setTimeout(() => document.getElementById('custom-todo-input')?.focus(), 0);
}

// ── Prep checklist toggle ──────────────────────────────
function togglePrepItem(loc, key) {
  if (!S.prepChecklist[loc]) S.prepChecklist[loc] = new Set();
  if (S.prepChecklist[loc].has(key)) {
    S.prepChecklist[loc].delete(key);
  } else {
    S.prepChecklist[loc].add(key);
  }
  schedulePrepSave(loc);
  // Re-render just the checklist section to avoid full page re-render
  renderPrepChecklist();
}

// ── Main content render ────────────────────────────────
function renderDashboardContent() {
  const el = document.getElementById('dash-content');
  if (!el) return;

  rebuildPlanner(); // always ensure fresh planner state
  const loc = S.dashboardLoc;
  const today = getToday();
  const todayIso = dateToIso(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = dateToIso(tomorrow);

  // ── Guest counts ──
  const lunchGuests = getGuests(loc, todayIso, 'lunch');
  const dinnerGuests = getGuests(loc, todayIso, 'dinner');

  // ── Today's menu ──
  let menuHtml = '';
  MEALS.forEach(meal => {
    const k = `${loc}-${todayIso}-${meal}`;
    const dishes = S.planner[k] || [];
    const gc = getGuests(loc, todayIso, meal);
    const mealLabel = meal.charAt(0).toUpperCase() + meal.slice(1);
    menuHtml += `<div class="dash-section">
      <div class="dash-section-hdr">${mealLabel} <span class="dash-section-guests">${gc} guests</span></div>`;
    if (dishes.length === 0) {
      menuHtml += `<div class="dash-empty">No batches planned</div>`;
    } else {
      const typeOrder = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
      const sorted = [...dishes].sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));
      sorted.forEach(d => {
        const liters = calcLitersForService(d, loc, todayIso, meal);
        const isMain = d.type === 'Main course';

        // Allergens (combine dish + extra)
        const allergens = [...(d.allergens || []), ...(d.extraAllergens || [])];
        const allergenHtml = allergens.length
          ? allergens.map(a => `<span class="dash-allergen">${esc(a)}</span>`).join('')
          : '<span class="dash-no-allergens">No allergens</span>';

        // Recipe link
        const recipeLink = d.recipeSheetId
          ? `<a class="dash-recipe-btn" href="https://docs.google.com/spreadsheets/d/${esc(d.recipeSheetId)}" target="_blank" onclick="event.stopPropagation()">📄 Recipe</a>`
          : '';

        // Starch picker for main courses — tap Rice or Pasta (tap again to deselect)
        const starchHtml = isMain ? `
          <div class="dash-starch-picker">
            <button class="dash-starch-opt${d.starch === 'Rice' ? ' selected' : ''}" onclick="setDishStarch('${esc(d.id)}','Rice');event.stopPropagation()">🍚 Rice</button>
            <button class="dash-starch-opt${d.starch === 'Pasta' ? ' selected' : ''}" onclick="setDishStarch('${esc(d.id)}','Pasta');event.stopPropagation()">🍝 Pasta</button>
          </div>` : '';

        menuHtml += `
          <div class="dash-menu-row">
            <div class="dash-menu-main">
              <span class="dash-type-dot dash-type-${(d.type||'').toLowerCase().replace(/ /g,'-')}"></span>
              <span class="dash-menu-name">${esc(d.name)}</span>
              <span class="dash-menu-liters">${liters} L</span>
              ${recipeLink}
            </div>
            <div class="dash-menu-meta">
              <div class="dash-allergen-row">${allergenHtml}</div>
              ${starchHtml}
            </div>
          </div>`;
      });

      // Starch cook summary — shows totals once mains are assigned
      menuHtml += starchSummaryHtml(sorted, gc);
    }
    menuHtml += '</div>';
  });

  // ── Todo data ──
  const menuToday    = getMenuDishes(loc, todayIso);
  const menuTomorrow = getMenuDishes(loc, tomorrowIso);

  // Heat up: split by lunch and dinner service
  const heatUpLunch  = (S.planner[`${loc}-${todayIso}-lunch`]  || []).filter(d => isBatchCooked(d));
  const heatUpDinner = (S.planner[`${loc}-${todayIso}-dinner`] || []).filter(d => isBatchCooked(d));
  const hasHeatUp = heatUpLunch.length > 0 || heatUpDinner.length > 0;

  // Cook: split into today lunch, today dinner, tomorrow
  const cookLunch    = (S.planner[`${loc}-${todayIso}-lunch`]  || []).filter(d => !isBatchCooked(d));
  const cookDinner   = (S.planner[`${loc}-${todayIso}-dinner`] || []).filter(d => !isBatchCooked(d));
  const cookTomorrow = menuTomorrow.filter(d => !isBatchCooked(d));
  const hasCook = cookLunch.length > 0 || cookDinner.length > 0 || cookTomorrow.length > 0;

  const vegToday    = getVegIngredients(menuToday);
  const vegTomorrow = getVegIngredients(menuTomorrow);
  const prepToday    = vegToday.map(i => ({ ...i, dayTag: 'today',    key: `today-${i.name.toLowerCase().trim()}` }));
  const prepTomorrow = vegTomorrow.map(i => ({ ...i, dayTag: 'tomorrow', key: `tomorrow-${i.name.toLowerCase().trim()}` }));
  const allPrep = [...prepToday, ...prepTomorrow].sort((a, b) => a.name.localeCompare(b.name));
  const checkedSet = S.prepChecklist[loc] || new Set();
  const doneCount  = allPrep.filter(i => checkedSet.has(i.key)).length;

  // ── Cook dish row helper — tappable checkbox ──
  function cookDishRow(d, note, checkedSet, toggleFn, dateStr, meal) {
    const checked = checkedSet && checkedSet.has(d.id);
    const req = (dateStr && meal) ? calcLitersForService(d, loc, dateStr, meal) : calcRequiredForLoc(d, loc);
    const typeColors = { 'Soup': 'green', 'Main course': 'blue', 'Dessert': 'purple' };
    const col = typeColors[d.type] || 'gray';
    return `<div class="dash-cook-item${checked ? ' checked' : ''}" onclick="${toggleFn}('${esc(d.id)}')">
      <div class="dash-prep-check">${checked ? '✓' : ''}</div>
      <span class="dash-cook-dot" style="background:var(--${col})"></span>
      <span class="dash-cook-name">${esc(d.name)}</span>
      <span class="dash-cook-meta">${note}</span>
      <span class="dash-cook-liters">${Math.round(req * 10) / 10} L</span>
    </div>`;
  }

  el.innerHTML = `
    <!-- ══ SECTION 1: TODAY'S OVERVIEW ══ -->
    <h2 class="dash-section-heading">Today's Overview</h2>

    <div class="dash-card" id="dash-guests-card">
      <div class="dash-card-title"><span class="dash-card-icon">👥</span> Guests today
        <span class="dash-card-subtitle">Expected headcount for today's service</span>
      </div>
      <div class="dash-guest-grid">
        <div class="dash-guest-box"><div class="dash-guest-num">${lunchGuests}</div><div class="dash-guest-label">Lunch</div></div>
        <div class="dash-guest-box"><div class="dash-guest-num">${dinnerGuests}</div><div class="dash-guest-label">Dinner</div></div>
      </div>
    </div>

    <div class="dash-card" id="dash-flow-card">
      <div class="dash-card-title">
        <span class="dash-card-icon">📈</span> Guest flow
        <span class="dash-card-subtitle">Estimated arrivals per 5 min</span>
        <div class="dash-flow-toggles" style="margin-left:auto;">
          <button class="dash-flow-toggle${_guestFlowMeal === 'lunch' ? ' active' : ''}" data-meal="lunch" onclick="setGuestFlowMeal('lunch')">Lunch</button>
          <button class="dash-flow-toggle${_guestFlowMeal === 'dinner' ? ' active' : ''}" data-meal="dinner" onclick="setGuestFlowMeal('dinner')">Dinner</button>
        </div>
      </div>
      <div class="dash-flow-canvas-wrap"><canvas id="guest-flow-canvas"></canvas></div>
    </div>

    <div class="dash-card" id="dash-menu-card">
      <div class="dash-card-title"><span class="dash-card-icon">🍲</span> Today's menu
        <span class="dash-card-subtitle">Pick Rice or Pasta for each main — totals appear below each meal</span>
      </div>
      ${menuHtml}
    </div>

    <!-- ══ SECTION 2: CHEF TODOS ══ -->
    <h2 class="dash-section-heading">Chef To-Dos</h2>

    <!-- 🔥 HEAT UP -->
    <div class="dash-card" id="dash-heatup-card">
      <div class="dash-card-title"><span class="dash-card-icon">🔥</span> What to heat up
        <span class="dash-card-subtitle">Already cooked — just needs reheating for today's service</span>
      </div>
      ${!hasHeatUp
        ? `<div class="dash-empty">Nothing marked as cooked yet — check the cook list below</div>`
        : `${heatUpLunch.length > 0 ? `
          <div class="dash-todo-group-hdr">🍴 Lunch service</div>
          ${heatUpLunch.map(d => cookDishRow(d, 'reheat', S.heatChecked, 'toggleHeatItem', todayIso, 'lunch')).join('')}` : ''}
        ${heatUpDinner.length > 0 ? `
          <div class="dash-todo-group-hdr"${heatUpLunch.length > 0 ? ' style="margin-top:10px;"' : ''}>🌙 Dinner service</div>
          ${heatUpDinner.map(d => cookDishRow(d, 'reheat', S.heatChecked, 'toggleHeatItem', todayIso, 'dinner')).join('')}` : ''}`
      }
    </div>

    <!-- 👨‍🍳 WHAT TO COOK -->
    <div class="dash-card" id="dash-cook-card">
      <div class="dash-card-title"><span class="dash-card-icon">👨‍🍳</span> What to cook
        <span class="dash-card-subtitle">Batches that still need to be cooked — stay 1 day ahead!</span>
      </div>
      ${!hasCook
        ? `<div class="dash-empty">All batches are cooked — great job! 🎉</div>`
        : `${cookLunch.length > 0 ? `
          <div class="dash-todo-group-hdr">🍴 Today — Lunch service</div>
          ${cookLunch.map(d => cookDishRow(d, 'cook today', S.cookChecked, 'toggleCookItem', todayIso, 'lunch')).join('')}` : ''}
        ${cookDinner.length > 0 ? `
          <div class="dash-todo-group-hdr"${cookLunch.length > 0 ? ' style="margin-top:10px;"' : ''}>🌙 Today — Dinner service</div>
          ${cookDinner.map(d => cookDishRow(d, 'cook today', S.cookChecked, 'toggleCookItem', todayIso, 'dinner')).join('')}` : ''}
        ${cookTomorrow.length > 0 ? `
          <div class="dash-todo-group-hdr"${(cookLunch.length + cookDinner.length) > 0 ? ' style="margin-top:10px;"' : ''}>📅 Future service</div>
          <div class="dash-todo-group-sub">Cook the full batch now — these batches are on the plan for upcoming slots</div>
          ${cookTomorrow.map(d => cookDishRow(d, 'upcoming', S.cookChecked, 'toggleCookItem')).join('')}` : ''}`
      }
    </div>

    <!-- 🔪 WHAT TO CHOP -->
    <div class="dash-card" id="dash-prep-card">
      <div class="dash-card-title"><span class="dash-card-icon">🔪</span> What to chop
        <span class="dash-card-subtitle">Fresh ingredients to prep — tap each to tick off as you go</span>
        ${allPrep.length > 0 ? `<span class="dash-prep-progress" style="margin-left:auto;">${doneCount}/${allPrep.length}</span>` : ''}
      </div>
      <div id="dash-prep-list"></div>
    </div>
  `;

  renderPrepChecklist();
  drawGuestFlowChart();
}

function renderPrepChecklist() {
  const el = document.getElementById('dash-prep-list');
  if (!el) return;

  rebuildPlanner();
  const loc = S.dashboardLoc;
  const today = getToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayIso2 = dateToIso(getToday());
  const tmrw2 = new Date(getToday()); tmrw2.setDate(tmrw2.getDate() + 1);
  const tomorrowIso2 = dateToIso(tmrw2);
  const cookToday = getMenuDishes(loc, todayIso2);
  const cookTomorrow = getMenuDishes(loc, tomorrowIso2);
  const vegToday = getVegIngredients(cookToday);
  const vegTomorrow = getVegIngredients(cookTomorrow);

  const prepToday = vegToday.map(i => ({ ...i, dayTag: 'today', key: `today-${i.name.toLowerCase().trim()}` }));
  const prepTomorrow = vegTomorrow.map(i => ({ ...i, dayTag: 'tomorrow', key: `tomorrow-${i.name.toLowerCase().trim()}` }));
  const checkedSet = S.prepChecklist[loc] || new Set();

  if (prepToday.length === 0 && prepTomorrow.length === 0) {
    el.innerHTML = `<div class="dash-empty">No fresh ingredients to prep — all clear! 🎉</div>`;
    return;
  }

  function renderItem(item) {
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

  // Always show split: Today first, then Tomorrow
  const todayItems   = prepToday.sort((a, b) => a.name.localeCompare(b.name));
  const tomorrowItems = prepTomorrow.sort((a, b) => a.name.localeCompare(b.name));
  let html = '';
  if (todayItems.length > 0) {
    const doneCt = todayItems.filter(i => checkedSet.has(i.key)).length;
    html += `<div class="dash-prep-group-hdr">
      🔥 Today's menu
      <span class="dash-prep-group-sub">Prep for today's service</span>
      <span class="dash-prep-group-count">${doneCt}/${todayItems.length}</span>
    </div>`;
    html += todayItems.map(renderItem).join('');
  }
  if (tomorrowItems.length > 0) {
    const doneCt = tomorrowItems.filter(i => checkedSet.has(i.key)).length;
    html += `<div class="dash-prep-group-hdr"${todayItems.length > 0 ? ' style="margin-top:12px;"' : ''}>
      📅 Tomorrow's menu
      <span class="dash-prep-group-sub">Prep ahead so tomorrow is smooth</span>
      <span class="dash-prep-group-count">${doneCt}/${tomorrowItems.length}</span>
    </div>`;
    html += tomorrowItems.map(renderItem).join('');
  }
  el.innerHTML = html;
}

function navTo(screen, subTab) {
  if (subTab) S.plannerSubTab = subTab;
  showScreen(screen);
}
