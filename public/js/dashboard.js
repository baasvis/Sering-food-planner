// SCREENS
// ═══════════════════════════════════════════════════════════════════

function showScreen(name, btn) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  btn.classList.add('active');
  rebuildPlanner();
  if (name === 'dashboard') renderDashboard();
  if (name === 'guests') renderGuests();
  if (name === 'planner') renderWeekPlan();
  if (name === 'recipe-index') renderRecipeIndex();
  if (name === 'orders') renderOrders();
}

// ── DASHBOARD ────────────────────────────────────────────
function getTodayIndex() {
  return (new Date().getDay() + 6) % 7; // 0=Mon ... 6=Sun
}

// Pantry/dry items to exclude from vegetable prep list (Dutch + English)
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

function calcLitersForService(dish, loc, dayIdx, meal) {
  const k = `${loc}-${dayIdx}-${meal}`;
  const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
  const count = Math.max(peers.length, 1);
  const g = getGuests(loc, dayIdx, meal);
  return Math.round((g / count) * ((dish.serving || 280) / 1000) * 10) / 10;
}

function getVegetables(dishes) {
  // Returns array of { dish, ingredients: [{name, amount, unit}] }
  const result = [];
  dishes.forEach(dish => {
    const ings = calcIngredientsFromRecipe(dish);
    if (!ings || ings.length === 0) return;
    const vegs = ings.filter(i => isVegetableIngredient(i.name));
    if (vegs.length > 0) result.push({ dish, ingredients: vegs });
  });
  return result;
}

function aggregateIngredients(dishesWithIngredients) {
  const combined = {};
  dishesWithIngredients.forEach(({ ingredients }) => {
    ingredients.forEach(ing => {
      const key = ing.name.toLowerCase().trim();
      if (!combined[key]) combined[key] = { name: ing.name, amount: 0, unit: ing.unit };
      combined[key].amount += ing.amount;
    });
  });
  return Object.values(combined).sort((a, b) => a.name.localeCompare(b.name));
}

const STARCH_OPTIONS = [null, 'Rice', 'Pasta'];

function cycleDishStarch(dishId) {
  const d = S.dishes.find(x => x.id === dishId);
  if (!d) return;
  const idx = STARCH_OPTIONS.indexOf(d.starch || null);
  d.starch = STARCH_OPTIONS[(idx + 1) % STARCH_OPTIONS.length];
  scheduleSave();
  renderDashboardContent();
}

function renderVegList(dishesWithVeg, mode) {
  if (dishesWithVeg.length === 0) return '<div class="dash-empty">No vegetables to cut</div>';

  if (mode === 'combined') {
    const agg = aggregateIngredients(dishesWithVeg);
    return '<div class="dash-veg-list">' + agg.map(i =>
      `<div class="dash-veg-item">
        <span class="dash-veg-name">${esc(i.name)}</span>
        <span class="dash-veg-amt">${Math.round(i.amount)} ${esc(i.unit)}</span>
      </div>`
    ).join('') + '</div>';
  }

  // Per-dish mode
  return dishesWithVeg.map(({ dish, ingredients }) =>
    `<div class="dash-veg-dish-hdr">${esc(dish.name)}</div>
     <div class="dash-veg-list">${ingredients.map(i =>
      `<div class="dash-veg-item">
        <span class="dash-veg-name">${esc(i.name)}</span>
        <span class="dash-veg-amt">${Math.round(i.amount)} ${esc(i.unit)}</span>
      </div>`
    ).join('')}</div>`
  ).join('');
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
  `;
  renderDashboardContent();
}

function setDashboardLoc(loc) {
  S.dashboardLoc = loc;
  document.querySelectorAll('.dash-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.dash-tab[onclick="setDashboardLoc('${loc}')"]`).classList.add('active');
  renderDashboardContent();
}

function toggleDashVegMode(which) {
  if (which === 'today') S.dashVegMode = S.dashVegMode === 'combined' ? 'per-dish' : 'combined';
  else S.dashVegModeTomorrow = S.dashVegModeTomorrow === 'combined' ? 'per-dish' : 'combined';
  renderDashboardContent();
}

function renderDashboardContent() {
  const el = document.getElementById('dash-content');
  if (!el) return;

  const loc = S.dashboardLoc;
  const todayIdx = getTodayIndex();
  const today = getToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // ── Guests ──
  const lunchGuests = getGuests(loc, todayIdx, 'lunch');
  const dinnerGuests = getGuests(loc, todayIdx, 'dinner');

  // ── Today's menu with liters + starch ──
  let menuHtml = '';
  MEALS.forEach(meal => {
    const k = `${loc}-${todayIdx}-${meal}`;
    const dishes = S.planner[k] || [];
    const gc = getGuests(loc, todayIdx, meal);
    menuHtml += `<div class="dash-section">
      <div class="dash-section-hdr">${meal} <span style="font-weight:400;color:var(--text3);">(${gc} guests)</span></div>`;
    if (dishes.length === 0) {
      menuHtml += `<div class="dash-empty">No dishes planned</div>`;
    } else {
      // Sort: Soup first, then Main course, then Dessert
      const typeOrder = { 'Soup': 0, 'Main course': 1, 'Dessert': 2 };
      const sorted = [...dishes].sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));
      sorted.forEach(d => {
        const liters = calcLitersForService(d, loc, todayIdx, meal);
        const isMain = d.type === 'Main course';
        const starch = d.starch || null;
        const starchLabel = starch || 'Pasta or rice?';
        const starchCls = starch ? 'dash-starch-btn on' : 'dash-starch-btn';
        menuHtml += `<div class="dash-dish-row ${chipClass(d)}" onclick="navTo('planner','overview')" style="cursor:pointer;">
          <span class="chip-nm">${esc(d.name)}</span>
          <span class="dash-liters">${liters}L</span>
          ${isMain ? `<button class="${starchCls}" onclick="event.stopPropagation();cycleDishStarch('${d.id}')">${starchLabel}</button>` : ''}
        </div>`;
      });

      // Starch totals for this meal
      const mainDishes = sorted.filter(d => d.type === 'Main course' && d.starch);
      if (mainDishes.length > 0) {
        const starchTotals = {};
        mainDishes.forEach(d => {
          const peers = sorted.filter(p => p.type === 'Main course');
          const guestsForDish = Math.round(gc / Math.max(peers.length, 1));
          const acc = ACCOMPANIMENTS.find(a => a.name === d.starch);
          if (!acc) return;
          const grams = guestsForDish * acc.gramsPerGuest;
          if (!starchTotals[d.starch]) starchTotals[d.starch] = 0;
          starchTotals[d.starch] += grams;
        });
        let starchHtml = '';
        Object.entries(starchTotals).forEach(([name, grams]) => {
          starchHtml += `<span class="dash-starch-total">${name}: ${(grams / 1000).toFixed(1)} kg</span>`;
        });
        menuHtml += `<div class="dash-starch-summary">${starchHtml}</div>`;
      }
    }
    menuHtml += '</div>';
  });

  // ── To cook today ──
  const cookToday = getCookDateDishes(loc, today);
  let cookHtml = '';
  if (cookToday.length === 0) {
    cookHtml = '<div class="dash-empty">Nothing to cook today</div>';
  } else {
    cookToday.forEach(d => {
      const req = calcRequired(d);
      cookHtml += `<div class="dash-cook-row">
        ${typeBadge(d.type)}
        <span class="dash-cook-name">${esc(d.name)}</span>
        <span class="dash-cook-liters">${req}L needed</span>
      </div>`;
    });
  }

  // ── Vegetables today ──
  const vegToday = getVegetables(cookToday);
  const vegTodayMode = S.dashVegMode;

  // ── Vegetables tomorrow ──
  const cookTomorrow = getCookDateDishes(loc, tomorrow);
  const vegTomorrow = getVegetables(cookTomorrow);
  const vegTomorrowMode = S.dashVegModeTomorrow;

  // ── Assemble ──
  el.innerHTML = `
    <div class="dash-grid" style="grid-template-columns:1fr;">
      <div class="dash-card">
        <div class="dash-card-title">
          <div class="dash-icon" style="background:var(--green-bg);color:var(--green);">&#9829;</div>
          Guests today
        </div>
        <div class="dash-guest-grid">
          <div class="dash-guest-box">
            <div class="dash-guest-num">${lunchGuests}</div>
            <div class="dash-guest-label">Lunch</div>
          </div>
          <div class="dash-guest-box">
            <div class="dash-guest-num">${dinnerGuests}</div>
            <div class="dash-guest-label">Dinner</div>
          </div>
        </div>
      </div>

      <div class="dash-card">
        <div class="dash-card-title">
          <div class="dash-icon" style="background:var(--blue-bg);color:var(--blue);">&#9734;</div>
          Today's menu
        </div>
        ${menuHtml}
      </div>

      <div class="dash-card">
        <div class="dash-card-title">
          <div class="dash-icon" style="background:var(--amber-bg);color:var(--amber);">&#9832;</div>
          To cook today
        </div>
        ${cookHtml}
      </div>

      <div class="dash-card">
        <div class="dash-card-title">
          <div class="dash-icon" style="background:var(--green-bg);color:var(--green);">&#9998;</div>
          Vegetables to cut today
          <button class="dash-toggle-btn${vegTodayMode === 'per-dish' ? ' on' : ''}" onclick="toggleDashVegMode('today')">${vegTodayMode === 'combined' ? 'Per dish' : 'Combined'}</button>
        </div>
        ${renderVegList(vegToday, vegTodayMode)}
      </div>

      <div class="dash-card">
        <div class="dash-card-title">
          <div class="dash-icon" style="background:var(--purple-bg);color:var(--purple);">&#9998;</div>
          Vegetables to cut tomorrow
          <button class="dash-toggle-btn${vegTomorrowMode === 'per-dish' ? ' on' : ''}" onclick="toggleDashVegMode('tomorrow')">${vegTomorrowMode === 'combined' ? 'Per dish' : 'Combined'}</button>
        </div>
        ${renderVegList(vegTomorrow, vegTomorrowMode)}
      </div>

    </div>
  `;
}

function navTo(screen, subTab) {
  const btns = document.querySelectorAll('.nav-btn');
  const labels = { dashboard:'Dashboard', guests:'Guests', planner:'Week plan', 'recipe-index':'Recipes', orders:'Orders' };
  if (subTab) S.plannerSubTab = subTab;
  btns.forEach(b => { if (b.textContent === labels[screen]) showScreen(screen, b); });
}
