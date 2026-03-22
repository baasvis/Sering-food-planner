// SCREENS
// ═══════════════════════════════════════════════════════════════════

function showScreen(name, btn) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  if (btn) btn.classList.add('active');
  // Sync top nav
  document.querySelectorAll('.top-bar .nav-btn').forEach(b => {
    if (b.textContent.trim() === (btn && btn.textContent.trim())) b.classList.add('active');
  });
  // Sync bottom nav
  document.querySelectorAll('.bnav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === name);
  });
  rebuildPlanner();
  if (name === 'dashboard') renderDashboard();
  if (name === 'guests') renderGuests();
  if (name === 'planner') renderWeekPlan();
  if (name === 'recipe-index') renderRecipeIndex();
  if (name === 'orders') renderOrders();
}

// ── DASHBOARD ────────────────────────────────────────────
// Pantry/dry items to exclude from prep list
const PANTRY_KEYWORDS = [
  'oil','olie','salt','zout','sugar','suiker','pepper','peper',
  'vinegar','azijn','soy sauce','sojasaus','ketjap','tamari',
  'flour','meel','bloem','butter','boter','margarine',
  'cream','room','slagroom','milk','melk',
  'stock','bouillon','broth',
  'powder','poeder','cumin','komijn','cinnamon','kaneel',
  'turmeric','kurkuma','paprikapoeder','chili powder','chilipoeder',
  'nutmeg','nootmuskaat','cloves','kruidnagel',
  'bay leaf','laurier','thyme','tijm','oregano','rosemary','rozemarijn',
  'basil','basilicum','parsley','peterselie','cilantro','koriander',
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
];

function isVegetableIngredient(name) {
  const lower = name.toLowerCase().trim();
  return !PANTRY_KEYWORDS.some(kw => lower.includes(kw));
}

function isDishAtLocation(dish, loc) {
  if (loc === 'west') return dish.logistics === 'Sering West' || dish.logistics === 'Transport to Sering Centraal';
  return dish.logistics === 'Sering Centraal' || dish.logistics === 'Transport to Sering West';
}

function getCookDateDishes(loc, date) {
  const dateStr = dateToStr(date);
  return S.dishes.filter(d =>
    d.cookDate === dateStr &&
    !d.cookConfirmed &&
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
    ings.filter(i => isVegetableIngredient(i.name)).forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      if (!combined[key]) combined[key] = { name: ing.name, amount: 0, unit: ing.unit };
      combined[key].amount += ing.amount;
    });
  });
  return Object.values(combined).sort((a, b) => a.name.localeCompare(b.name));
}

// Per-dish starch selector (Rice or Pasta)
function setDishStarch(dishId, starch) {
  const d = S.dishes.find(x => x.id === dishId);
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
      menuHtml += `<div class="dash-empty">No dishes planned</div>`;
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
  const heatUpLunch  = (S.planner[`${loc}-${todayIso}-lunch`]  || []).filter(d => d.cookConfirmed);
  const heatUpDinner = (S.planner[`${loc}-${todayIso}-dinner`] || []).filter(d => d.cookConfirmed);
  const hasHeatUp = heatUpLunch.length > 0 || heatUpDinner.length > 0;

  // Cook: split into today lunch, today dinner, tomorrow
  const cookLunch    = (S.planner[`${loc}-${todayIso}-lunch`]  || []).filter(d => !d.cookConfirmed);
  const cookDinner   = (S.planner[`${loc}-${todayIso}-dinner`] || []).filter(d => !d.cookConfirmed);
  const cookTomorrow = menuTomorrow.filter(d => !d.cookConfirmed);
  const hasCook = cookLunch.length > 0 || cookDinner.length > 0 || cookTomorrow.length > 0;

  const vegToday    = getVegIngredients(menuToday);
  const vegTomorrow = getVegIngredients(menuTomorrow);
  const prepToday    = vegToday.map(i => ({ ...i, dayTag: 'today',    key: `today-${i.name.toLowerCase().trim()}` }));
  const prepTomorrow = vegTomorrow.map(i => ({ ...i, dayTag: 'tomorrow', key: `tomorrow-${i.name.toLowerCase().trim()}` }));
  const allPrep = [...prepToday, ...prepTomorrow].sort((a, b) => a.name.localeCompare(b.name));
  const checkedSet = S.prepChecklist[loc] || new Set();
  const doneCount  = allPrep.filter(i => checkedSet.has(i.key)).length;

  // ── Cook dish row helper — tappable checkbox ──
  function cookDishRow(d, note, checkedSet, toggleFn) {
    const checked = checkedSet && checkedSet.has(d.id);
    const req = calcRequired(d);
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
          ${heatUpLunch.map(d => cookDishRow(d, 'reheat', S.heatChecked, 'toggleHeatItem')).join('')}` : ''}
        ${heatUpDinner.length > 0 ? `
          <div class="dash-todo-group-hdr"${heatUpLunch.length > 0 ? ' style="margin-top:10px;"' : ''}>🌙 Dinner service</div>
          ${heatUpDinner.map(d => cookDishRow(d, 'reheat', S.heatChecked, 'toggleHeatItem')).join('')}` : ''}`
      }
    </div>

    <!-- 👨‍🍳 WHAT TO COOK -->
    <div class="dash-card" id="dash-cook-card">
      <div class="dash-card-title"><span class="dash-card-icon">👨‍🍳</span> What to cook
        <span class="dash-card-subtitle">Dishes that still need to be cooked — stay 1 day ahead!</span>
      </div>
      ${!hasCook
        ? `<div class="dash-empty">All dishes are cooked — great job! 🎉</div>`
        : `${cookLunch.length > 0 ? `
          <div class="dash-todo-group-hdr">🍴 Today — Lunch service</div>
          ${cookLunch.map(d => cookDishRow(d, 'cook today', S.cookChecked, 'toggleCookItem')).join('')}` : ''}
        ${cookDinner.length > 0 ? `
          <div class="dash-todo-group-hdr"${cookLunch.length > 0 ? ' style="margin-top:10px;"' : ''}>🌙 Today — Dinner service</div>
          ${cookDinner.map(d => cookDishRow(d, 'cook today', S.cookChecked, 'toggleCookItem')).join('')}` : ''}
        ${cookTomorrow.length > 0 ? `
          <div class="dash-todo-group-hdr"${(cookLunch.length + cookDinner.length) > 0 ? ' style="margin-top:10px;"' : ''}>📅 Future service</div>
          <div class="dash-todo-group-sub">Cook the full batch now — these dishes are on the plan for upcoming slots</div>
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
  const btns = document.querySelectorAll('.nav-btn');
  const labels = { dashboard:'Dashboard', guests:'Guests', planner:'Week plan', 'recipe-index':'Recipes', orders:'Orders' };
  if (subTab) S.plannerSubTab = subTab;
  btns.forEach(b => { if (b.textContent === labels[screen]) showScreen(screen, b); });
}
