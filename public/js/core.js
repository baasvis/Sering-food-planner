// CORE LOGIC
// ═══════════════════════════════════════════════════════════════════

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
  S.dishes.forEach(d => {
    (d.services || []).forEach(svc => {
      const k = `${svc.loc}-${svc.date}-${svc.meal}`;
      if (!S.planner[k]) S.planner[k] = [];
      if (!S.planner[k].find(x => x.id === d.id)) S.planner[k].push(d);
    });
  });
}

function renderDishListSplit(dishes) {
  const cooked = sortByCookDate(dishes.filter(d => d.cookConfirmed));
  const uncooked = sortByCookDate(dishes.filter(d => !d.cookConfirmed));
  let html = '';
  if (uncooked.length > 0) {
    html += `<div class="cook-group-hdr uncooked-hdr">To cook (${uncooked.length})</div>`;
    uncooked.forEach(d => { html += renderDishRow(d); });
  }
  if (cooked.length > 0) {
    html += `<div class="cook-group-hdr cooked-hdr">Cooked (${cooked.length})</div>`;
    cooked.forEach(d => { html += renderDishRow(d); });
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

  // Check S.guestsNextWeeks for this date's week
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  const mk = dateToIso(mon);
  const weekData = S.guestsNextWeeks[mk];
  if (weekData && weekData[lk] && weekData[lk][dn] && weekData[lk][dn][meal] !== undefined) {
    return weekData[lk][dn][meal];
  }

  // Fall back to current week's base guest counts
  return ((S.guests[lk] || {})[dn] || {})[meal] || 0;
}

function calcRequired(dish) {
  let total = 0;
  (dish.services || []).forEach(svc => {
    if (isServicePast(svc)) return; // Skip served services — no longer pulling stock
    const g = getGuests(svc.loc, svc.date, svc.meal);
    const k = `${svc.loc}-${svc.date}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
    const count = Math.max(peers.length, 1);
    total += (g / count) * ((dish.serving || 280) / 1000);
  });
  // Add catering requirements (split by same-type peers)
  (S.caterings || []).forEach(c => {
    const cd = (c.dishes || []).find(cd => cd.dishId === dish.id);
    if (cd) {
      const peers = (c.dishes || []).filter(d => d.type === dish.type).length;
      total += ((c.guestCount || 0) / Math.max(peers, 1)) * ((dish.serving || 280) / 1000);
    }
  });
  return Math.round(total * 10) / 10;
}

function calcRequiredBreakdown(dish) {
  const lines = [];
  (dish.services || []).forEach(svc => {
    const loc = svc.loc === 'west' ? 'Sering West' : 'Sering Centraal';
    const meal = svc.meal.charAt(0).toUpperCase() + svc.meal.slice(1);
    const dayName = dateToDayName(svc.date);
    // Past services show as "served" instead of contributing liters
    if (isServicePast(svc)) {
      lines.push(`✓ ${dayName} ${meal} ${loc} (served)`);
      return;
    }
    const g = getGuests(svc.loc, svc.date, svc.meal);
    const k = `${svc.loc}-${svc.date}-${svc.meal}`;
    const peers = (S.planner[k] || []).filter(d => d.type === dish.type);
    const count = Math.max(peers.length, 1);
    const liters = Math.round((g / count) * ((dish.serving || 280) / 1000) * 10) / 10;
    if (liters > 0) {
      lines.push(`${liters}L — ${dayName} ${meal} ${loc}`);
    }
  });
  (S.caterings || []).forEach(c => {
    const cd = (c.dishes || []).find(cd => cd.dishId === dish.id);
    if (cd) {
      const peers = (c.dishes || []).filter(d => d.type === dish.type).length;
      const liters = Math.round(((c.guestCount || 0) / Math.max(peers, 1)) * ((dish.serving || 280) / 1000) * 10) / 10;
      if (liters > 0) lines.push(`${liters}L — ${c.name} (${c.guestCount} guests${peers > 1 ? ', 1/' + peers + ' split' : ''})`);
    }
  });
  return lines;
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
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  const idx = STORAGE.indexOf(d.storage || 'Gastro');
  d.storage = STORAGE[(idx + 1) % STORAGE.length];
  scheduleSave();
  rerenderCurrentView();
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
  rerenderCurrentView();
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
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  const idx = TYPES.indexOf(d.type || 'Soup');
  d.type = TYPES[(idx + 1) % TYPES.length];
  scheduleSave();
  rerenderCurrentView();
}
function toggleOrder(id) {
  const d = S.dishes.find(x => x.id === id);
  if (!d) return;
  d.orderFor = !d.orderFor;
  scheduleSave();
  rerenderCurrentView();
}
function chipClass(d) {
  if ((d.logistics || '').startsWith('Transport')) return 'chip-tr';
  if (d.type === 'Soup') return 'chip-soup';
  if (d.type === 'Dessert') return 'chip-dessert';
  return 'chip-main';
}

// ═══════════════════════════════════════════════════════════════════
