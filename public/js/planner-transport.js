// ── TRANSPORT VIEW ───────────────────────────────────────
function renderTransportView() {
  const transportDishes = S.batches.filter(d => d.inTransit === true);

  let html = `<div id="split-bar-area"></div>`;

  // ── Transport items (custom free-text items) ──
  html += `<div class="type-section">`;
  html += `<div class="type-section-hdr">Items to transport</div>`;
  html += `<div style="display:flex;gap:6px;margin-bottom:8px;">
    <input type="text" id="transport-item-input" placeholder="Add item to remember..." style="flex:1;font-size:13px;height:32px;border:1px solid var(--border2);border-radius:var(--radius);padding:0 10px;background:var(--bg);color:var(--text);" onkeydown="if(event.key==='Enter')addTransportItem()" />
    <button class="btn btn-primary" onclick="addTransportItem()" style="height:32px;">Add</button>
  </div>`;
  if ((S.transportItems || []).length > 0) {
    S.transportItems.forEach(item => {
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:4px;">
        <span style="flex:1;font-size:13px;">${esc(item.text)}</span>
        <button class="btn btn-sm" style="font-size:11px;color:var(--green);border-color:var(--green);" onclick="deliverTransportItem('${item.id}')">Delivered</button>
      </div>`;
    });
  } else {
    html += `<div style="font-size:12px;color:var(--text3);padding:4px 0;">No extra items</div>`;
  }
  html += `</div>`;

  // ── Dishes being transported ──
  if (transportDishes.length > 0) {
    html += `<div class="type-section">`;
    html += `<div class="type-section-hdr">Batches in transport</div>`;
    html += `<div style="margin-bottom:8px;display:flex;gap:6px;">
      <button class="btn btn-sm" style="color:var(--green);border-color:var(--green);" onclick="markSelectedArrived()">Mark selected as arrived</button>
    </div>`;

    // Show all transport batches in a single flat list (no date grouping)
    html += `<div class="batch-tile-grid">`;
    transportDishes.forEach(d => {
      html += renderBatchTile(d, false);
    });
    html += `</div>`;

    html += `</div>`; // close dishes in transport section
  } else {
    html += `<div class="empty" style="margin-top:12px;">No batches marked for transport</div>`;
  }

  document.getElementById('planner-content').innerHTML = html;
  renderSplitBar();
}

// ── Transport item functions ─────────────────────────────
function addTransportItem() {
  const input = document.getElementById('transport-item-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  S.transportItems.push({ id: newId(), text });
  input.value = '';
  scheduleSave();
  rerenderCurrentView();
}

function deliverTransportItem(id) {
  S.transportItems = S.transportItems.filter(i => i.id !== id);
  scheduleSave();
  rerenderCurrentView();
  toast('Item delivered');
}

function markSelectedArrived() {
  const selected = [...S.selected];
  if (selected.length === 0) { toast('Select batches first using the checkboxes'); return; }
  let count = 0;
  selected.forEach(id => {
    const d = S.batches.find(x => x.id === id);
    if (d && d.inTransit) {
      d.inTransit = false;
      count++;
    }
  });
  S.selected.clear();
  if (count > 0) {
    scheduleSave();
    rerenderCurrentView();
    toast(`${count} batch${count > 1 ? 'es' : ''} marked as arrived`);
  }
}
