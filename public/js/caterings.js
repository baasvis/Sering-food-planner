// ── CATERINGS ─────────────────────────────────────────────

function renderCaterings() {
  const el = document.getElementById('planner-content');
  if (!el) return;

  const caterings = S.caterings || [];

  if (caterings.length === 0) {
    el.innerHTML = `
      <div class="btn-row" style="margin-bottom:12px;">
        <button class="btn btn-primary" onclick="openNewCatering()">+ New Catering</button>
      </div>
      <div class="empty">No caterings yet. Click "+ New Catering" to add one.</div>`;
    return;
  }

  // Sort by date
  const sorted = [...caterings].sort((a, b) => {
    const da = a.date ? strToDate(a.date) : new Date(9999, 0);
    const db = b.date ? strToDate(b.date) : new Date(9999, 0);
    return da - db;
  });

  let html = `<div class="btn-row" style="margin-bottom:12px;">
    <button class="btn btn-primary" onclick="openNewCatering()">+ New Catering</button>
  </div>`;

  sorted.forEach(c => {
    const deliveryLabel = { pickup: 'Pickup', delivery: 'Delivery', 'on-location': 'On location' }[c.deliveryMode] || c.deliveryMode;
    const dishList = (c.dishes || []).map(d => {
      const dish = S.batches.find(x => x.id === d.dishId);
      const serving = dish ? (dish.serving || 280) : 280;
      const peers = (c.dishes || []).filter(cd => cd.type === d.type).length;
      const liters = Math.round(((c.guestCount || 0) / Math.max(peers, 1)) * serving / 1000 * 10) / 10;
      return `<span class="badge ${d.type === 'Soup' ? 'b-soup' : d.type === 'Dessert' ? 'b-dessert' : 'b-main'}" style="margin:1px;">${esc(d.name)} · ${liters}L</span>`;
    }).join(' ');

    html += `<div class="card" style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div>
          <div style="font-size:15px;font-weight:600;">${esc(c.name)}</div>
          <div style="font-size:12px;color:var(--text2);margin-top:2px;">${c.date ? `<strong style="color:var(--text);">${c.date}</strong>` : '<strong style="color:var(--red);">No date</strong>'} · ${c.guestCount || '?'} guests · ${deliveryLabel}</div>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-sm" onclick="openEditCatering('${c.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteCatering('${c.id}')">Delete</button>
        </div>
      </div>
      ${dishList ? `<div style="margin-top:8px;">${dishList}</div>` : '<div style="font-size:12px;color:var(--text3);margin-top:8px;">No batches added yet</div>'}
      ${c.logisticsNotes ? `<div style="font-size:12px;color:var(--text2);margin-top:6px;background:var(--bg2);padding:6px 10px;border-radius:var(--radius);">${esc(c.logisticsNotes)}</div>` : ''}
    </div>`;
  });

  el.innerHTML = html;
}

function openNewCatering() {
  showModal(`<h3>New Catering</h3>
    <div class="fr"><label>Name / Event</label><input type="text" id="ct-name" placeholder="e.g. Protest march catering" /></div>
    <div class="fr"><label>Date</label><input type="date" id="ct-date" /></div>
    <div class="fr"><label>Guest count</label><input type="number" id="ct-guests" value="50" min="1" /></div>
    <div class="fr"><label>Delivery mode</label><select id="ct-delivery">
      <option value="pickup">Pickup</option>
      <option value="delivery">Delivery</option>
      <option value="on-location">On location (we cook there)</option>
    </select></div>
    <div class="fr"><label>Logistics notes</label><textarea id="ct-notes" rows="3" style="width:100%;font-size:13px;border:1px solid var(--border2);border-radius:var(--radius);padding:8px;background:var(--bg);color:var(--text);font-family:inherit;" placeholder="Address, contact, special instructions..."></textarea></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveNewCatering()">Create</button>
    </div>`);
}

function saveNewCatering() {
  const name = document.getElementById('ct-name').value.trim();
  if (!name) { alert('Please enter a name'); return; }
  const dateInput = document.getElementById('ct-date').value;
  const catering = {
    id: newId(),
    name,
    date: dateInput ? isoToCookDate(dateInput) : null,
    guestCount: parseInt(document.getElementById('ct-guests').value) || 50,
    deliveryMode: document.getElementById('ct-delivery').value,
    dishes: [],
    logisticsNotes: document.getElementById('ct-notes').value.trim(),
  };
  S.caterings.push(catering);
  closeModal(); renderCaterings(); scheduleSave();
  toast(`Catering "${name}" created`);
}

function openEditCatering(id) {
  const c = S.caterings.find(x => x.id === id);
  if (!c) return;
  const dateVal = c.date ? cookDateToISO(c.date) : '';
  showModal(`<h3>Edit Catering</h3>
    <div class="fr"><label>Name / Event</label><input type="text" id="ct-name" value="${esc(c.name)}" /></div>
    <div class="fr"><label>Date</label><input type="date" id="ct-date" value="${dateVal}" /></div>
    <div class="fr"><label>Guest count</label><input type="number" id="ct-guests" value="${c.guestCount || 50}" min="1" /></div>
    <div class="fr"><label>Delivery mode</label><select id="ct-delivery">
      <option value="pickup"${c.deliveryMode === 'pickup' ? ' selected' : ''}>Pickup</option>
      <option value="delivery"${c.deliveryMode === 'delivery' ? ' selected' : ''}>Delivery</option>
      <option value="on-location"${c.deliveryMode === 'on-location' ? ' selected' : ''}>On location (we cook there)</option>
    </select></div>
    <div class="fr"><label>Logistics notes</label><textarea id="ct-notes" rows="3" style="width:100%;font-size:13px;border:1px solid var(--border2);border-radius:var(--radius);padding:8px;background:var(--bg);color:var(--text);font-family:inherit;">${esc(c.logisticsNotes || '')}</textarea></div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
      <label style="font-size:12px;font-weight:500;color:var(--text2);margin-bottom:6px;display:block;">Batches</label>
      <div id="ct-dish-list">${renderCateringDishList(c)}</div>
      <button class="btn btn-sm" style="margin-top:6px;" onclick="openAddCateringDish('${id}')">+ Add batch</button>
    </div>
    <div class="modal-actions">
      <button class="btn btn-danger btn-sm" onclick="deleteCatering('${id}')">Delete</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveEditCatering('${id}')">Save</button>
    </div>`);
}

function renderCateringDishList(c) {
  if (!c.dishes || c.dishes.length === 0) return '<div style="font-size:12px;color:var(--text3);">No batches yet</div>';
  return c.dishes.map((d, i) => {
    const dish = S.batches.find(x => x.id === d.dishId);
    const serving = dish ? (dish.serving || 280) : 280;
    const peers = (c.dishes || []).filter(cd => cd.type === d.type).length;
    const liters = Math.round(((c.guestCount || 0) / Math.max(peers, 1)) * serving / 1000 * 10) / 10;
    return `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;">
    ${typeBadge(d.type || 'Soup')}
    <span style="font-size:13px;flex:1;">${esc(d.name)}</span>
    <span style="font-size:12px;color:var(--text2);" title="${c.guestCount} guests${peers > 1 ? ' ÷ ' + peers + ' ' + d.type + 's' : ''} × ${serving}ml">${liters}L</span>
    <button class="btn btn-sm btn-danger" onclick="removeCateringDish('${c.id}',${i})">×</button>
  </div>`;
  }).join('');
}

function openAddCateringDish(cateringId) {
  renderCateringDishPicker(cateringId, '');
}

function renderCateringDishPicker(cateringId, query) {
  const c = S.caterings.find(x => x.id === cateringId);
  const alreadyAdded = new Set((c?.dishes || []).map(d => d.dishId));
  const q = query.toLowerCase();

  // Only show planned dishes (they have serving size + stock tracking)
  const available = S.batches
    .filter(d => !alreadyAdded.has(d.id))
    .filter(d => !q || d.name.toLowerCase().includes(q));

  let list = '';

  if (available.length > 0) {
    list += available.slice(0, 20).map(d => {
      const { str, cls } = diffStr(d);
      const stockLoc = logisticsShort(d);
      const cookStatus = isBatchCooked(d) ? 'Cooked' : d.cookDate ? 'Cook: ' + d.cookDate : '';
      const serving = d.serving || 280;
      const sameTypePeers = (c.dishes || []).filter(cd => cd.type === d.type).length + 1; // +1 for this dish being added
      const cateringLiters = Math.round(((c.guestCount || 0) / sameTypePeers) * serving / 1000 * 10) / 10;
      return `<div class="dish-opt" onclick="addCateringDishFromPlanner('${cateringId}','${d.id}')">
        <div style="flex:1;">
          <div><span style="font-weight:500;">${esc(d.name)}</span> ${typeBadge(d.type)} ${storageBadge(d.storage || 'Gastro')}</div>
          <div style="font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
            <span style="font-weight:600;">${d.stock}L stock</span>
            <span class="${cls}">${str}</span>
            <span class="${logisticsBadgeClass(d)}" style="font-size:10px;">${stockLoc}</span>
            <span style="color:var(--text3);">+${cateringLiters}L for this catering</span>
            ${cookStatus ? `<span style="color:var(--text3);">${cookStatus}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  if (!list) list = `<div class="empty">No planned batches found${q ? ' matching "' + esc(q) + '"' : ''}</div>`;

  showModal(`<h3>Add batch to catering</h3>
    <input type="text" class="dish-search" id="ct-dish-search" placeholder="Search planned batches..." value="${esc(query)}"
      oninput="renderCateringDishPicker('${cateringId}',this.value)" />
    <div class="dish-opts-list" style="max-height:300px;">${list}</div>
    <div class="modal-actions"><button class="btn" onclick="openEditCatering('${cateringId}')">Back</button></div>`);
  const si = document.getElementById('ct-dish-search');
  if (si) { si.focus(); si.setSelectionRange(si.value.length, si.value.length); }
}

function addCateringDishFromPlanner(cateringId, dishId) {
  const c = S.caterings.find(x => x.id === cateringId);
  const d = S.batches.find(x => x.id === dishId);
  if (!c || !d) return;
  if (!c.dishes) c.dishes = [];
  c.dishes.push({ dishId: d.id, name: d.name, type: d.type || 'Soup' });
  scheduleSave();
  openEditCatering(cateringId);
}

function removeCateringDish(cateringId, index) {
  const c = S.caterings.find(x => x.id === cateringId);
  if (!c || !c.dishes) return;
  c.dishes.splice(index, 1);
  scheduleSave();
  openEditCatering(cateringId);
}


function saveEditCatering(id) {
  const c = S.caterings.find(x => x.id === id);
  if (!c) return;
  c.name = document.getElementById('ct-name').value.trim() || c.name;
  const dateInput = document.getElementById('ct-date').value;
  c.date = dateInput ? isoToCookDate(dateInput) : null;
  c.guestCount = parseInt(document.getElementById('ct-guests').value) || 50;
  c.deliveryMode = document.getElementById('ct-delivery').value;
  c.logisticsNotes = document.getElementById('ct-notes').value.trim();
  closeModal(); renderCaterings(); scheduleSave();
  toast('Catering saved');
}

function deleteCatering(id) {
  if (!confirm('Delete this catering?')) return;
  S.caterings = S.caterings.filter(c => c.id !== id);
  closeModal(); renderCaterings(); scheduleSave();
  toast('Catering deleted');
}
