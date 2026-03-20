// CORE LOGIC
// ═══════════════════════════════════════════════════════════════════

function rebuildPlanner() {
  S.planner = {};
  S.dishes.forEach(d => {
    (d.services || []).forEach(svc => {
      const k = `${svc.loc}-${svc.day}-${svc.meal}`;
      if (!S.planner[k]) S.planner[k] = [];
      if (!S.planner[k].find(x => x.id === d.id)) S.planner[k].push(d);
    });
  });
}

function getGuests(loc, dayIdx, meal) {
  const lk = loc === 'west' ? 'west' : 'centraal';
  const dn = DAYS[dayIdx];
  return ((S.guests[lk] || {})[dn] || {})[meal] || 0;
}

function calcRequired(dish) {
  let total = 0;
  (dish.services || []).forEach(svc => {
    const g = getGuests(svc.loc, svc.day, svc.meal);
    const k = `${svc.loc}-${svc.day}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
    const count = Math.max(peers.length, 1);
    total += (g / count) * ((dish.serving || 280) / 1000);
  });
  return Math.round(total * 10) / 10;
}

function calcTotalGuests(dish) {
  let g = 0;
  (dish.services || []).forEach(svc => {
    const total = getGuests(svc.loc, svc.day, svc.meal);
    const k = `${svc.loc}-${svc.day}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
    g += total / Math.max(peers.length, 1);
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
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  const idx = STORAGE.indexOf(d.storage || 'Gastro');
  d.storage = STORAGE[(idx + 1) % STORAGE.length];
  scheduleSave();
  renderDishes();
}
function logisticsBadge(l) {
  if (l === 'Sering Centraal') return `<span class="badge b-centraal">Sering Centraal</span>`;
  if (l === 'Transport to Sering Centraal') return `<span class="badge b-twc">&rarr; Sering Centraal</span>`;
  if (l === 'Transport to Sering West') return `<span class="badge b-tww">&rarr; Sering West</span>`;
  return `<span class="badge b-west">Sering West</span>`;
}
function logisticsBadgeClass(l) {
  if (l === 'Sering Centraal') return 'badge b-centraal';
  if (l === 'Transport to Sering Centraal') return 'badge b-twc';
  if (l === 'Transport to Sering West') return 'badge b-tww';
  return 'badge b-west';
}
function logisticsShort(l) {
  if (l === 'Sering Centraal') return 'Sering Centraal';
  if (l === 'Transport to Sering Centraal') return '→ Sering Centraal';
  if (l === 'Transport to Sering West') return '→ Sering West';
  return 'Sering West';
}
function cycleLogistics(id) {
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  const idx = LOGISTICS.indexOf(d.logistics || 'Sering West');
  d.logistics = LOGISTICS[(idx + 1) % LOGISTICS.length];
  rebuildPlanner();
  scheduleSave();
  renderDishes();
}

// ── SERVED / ARCHIVE ─────────────────────────────────────
function openServedDialog(id) {
  const d = S.dishes.find(x => x.id === id);
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
  const d = S.dishes.find(x => x.id === id);
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
  S.dishes = S.dishes.filter(x => x.id !== id);
  pendingRatings = { skill:0, speed:0, banger:0 };
  closeModal();
  rebuildPlanner();
  renderDishes();
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
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  const idx = TYPES.indexOf(d.type || 'Soup');
  d.type = TYPES[(idx + 1) % TYPES.length];
  scheduleSave();
  renderDishes();
}
function toggleOrder(id) {
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  d.orderFor = !d.orderFor;
  scheduleSave();
  renderDishes();
}
function chipClass(d) {
  if ((d.logistics || '').startsWith('Transport')) return 'chip-tr';
  if (d.type === 'Soup') return 'chip-soup';
  if (d.type === 'Dessert') return 'chip-dessert';
  return 'chip-main';
}

// ═══════════════════════════════════════════════════════════════════
