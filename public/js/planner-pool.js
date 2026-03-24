// ── BATCH POOL (per-type, below each calendar) ─────────
function getPoolBatches(loc) {
  return S.batches.filter(d => {
    const hasSvcHere = (d.services || []).some(s => s.loc === loc);
    const locatedHere = d.location === loc && (d.services || []).length === 0;
    return hasSvcHere || locatedHere;
  });
}

function toggleTypeBatchPool(typeKey) {
  if (!S.openBatchPools) S.openBatchPools = new Set();
  if (S.openBatchPools.has(typeKey)) S.openBatchPools.delete(typeKey);
  else S.openBatchPools.add(typeKey);
  rerenderCurrentView();
}

function renderTypeBatchPool(loc, typeKey, typeLabel, typeCls) {
  const poolBatches = getPoolBatches(loc).filter(d => d.type === typeKey);
  if (poolBatches.length === 0) return '';

  if (!S.openBatchPools) S.openBatchPools = new Set();
  const isOpen = S.openBatchPools.has(typeKey);

  let html = `<div class="batch-pool batch-pool-inline">`;
  html += `<button class="batch-pool-toggle" onclick="toggleTypeBatchPool('${typeKey}')">
    <span class="batch-pool-toggle-arrow">${isOpen ? '▾' : '▸'}</span>
    <span class="type-dot ${typeCls}"></span>${typeLabel}
    <span class="batch-pool-count">${poolBatches.length}</span>
  </button>`;

  if (isOpen) {
    const toCook = sortByCookDate(poolBatches.filter(d => !isBatchCooked(d) && d.storage !== 'Frozen'));
    const cooked = sortByCookDate(poolBatches.filter(d => isBatchCooked(d) && d.storage !== 'Frozen'));
    const frozen = poolBatches.filter(d => d.storage === 'Frozen');

    const renderGroup = (batches) => {
      return `<div class="batch-tile-grid">${batches.map(d => renderBatchTile(d, true)).join('')}</div>`;
    };

    if (toCook.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--amber);"></div>To cook <span class="dish-section-count">(${toCook.length})</span></div>`;
      html += renderGroup(toCook);
    }
    if (cooked.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--green);"></div>Cooked <span class="dish-section-count">(${cooked.length})</span></div>`;
      html += renderGroup(cooked);
    }
    if (frozen.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--blue);"></div>Frozen <span class="dish-section-count">(${frozen.length})</span></div>`;
      html += renderGroup(frozen);
    }
  }

  html += `</div>`;
  return html;
}

// ── "SHOW ALL BATCHES" COLLAPSIBLE ──────────────────────
function toggleShowAllBatches() {
  S.showAllBatches = !S.showAllBatches;
  rerenderCurrentView();
}

function renderShowAllBatches(loc) {
  const poolBatches = getPoolBatches(loc);
  if (poolBatches.length === 0) return '';

  let html = `<div class="batch-pool-showAll">`;
  html += `<button class="btn-show-all-batches" onclick="toggleShowAllBatches()">
    ${S.showAllBatches ? '▾ Hide all batches' : '▸ Show all batches'} <span class="batch-pool-count">${poolBatches.length}</span>
  </button>`;

  if (S.showAllBatches) {
    const toCook = sortByCookDate(poolBatches.filter(d => !isBatchCooked(d) && d.storage !== 'Frozen'));
    const cooked = sortByCookDate(poolBatches.filter(d => isBatchCooked(d) && d.storage !== 'Frozen'));
    const frozen = poolBatches.filter(d => d.storage === 'Frozen');

    const renderGroup = (batches) => {
      return `<div class="batch-tile-grid">${batches.map(d => renderBatchTile(d, true)).join('')}</div>`;
    };

    if (toCook.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--amber);"></div>To cook <span class="dish-section-count">(${toCook.length})</span></div>`;
      html += renderGroup(toCook);
    }
    if (cooked.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--green);"></div>Cooked <span class="dish-section-count">(${cooked.length})</span></div>`;
      html += renderGroup(cooked);
    }
    if (frozen.length) {
      html += `<div class="dish-section-hdr"><div class="dish-section-dot" style="background:var(--blue);"></div>Frozen <span class="dish-section-count">(${frozen.length})</span></div>`;
      html += renderGroup(frozen);
    }
  }

  html += `</div>`;
  return html;
}

// ── DRAG & DROP ─────────────────────────────────────────
function batchDragStart(e, batchId) {
  S.draggingBatchId = batchId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', batchId);
  e.target.closest('.batch-tile').classList.add('dragging');
  // Highlight all slots as drop targets
  document.querySelectorAll('.slot').forEach(s => s.classList.add('slot-assign-target'));
}

function batchDragEnd(e) {
  S.draggingBatchId = null;
  const tile = e.target.closest('.batch-tile');
  if (tile) tile.classList.remove('dragging');
  document.querySelectorAll('.slot').forEach(s => {
    s.classList.remove('slot-assign-target', 'slot-drag-over');
  });
}

function slotDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('slot-drag-over');
}

function slotDragLeave(e) {
  e.currentTarget.classList.remove('slot-drag-over');
}

function slotDrop(e, loc, date, meal) {
  e.preventDefault();
  e.currentTarget.classList.remove('slot-drag-over');
  const batchId = S.draggingBatchId || e.dataTransfer.getData('text/plain');
  if (!batchId) return;
  const batch = S.batches.find(d => d.id === batchId);
  if (!batch) return;
  const already = (batch.services || []).some(s => s.loc === loc && s.date === date && s.meal === meal);
  if (already) { toast('Already assigned to this slot'); return; }
  if (!batch.services) batch.services = [];
  batch.services.push({ loc, date, meal });
  S.draggingBatchId = null;
  rebuildPlanner();
  scheduleSave();
  rerenderCurrentView();
  toast(`${batch.name} assigned to ${dateToDayName(date)} ${meal}`);
}

// ── ASSIGN MODE ─────────────────────────────────────────
function startAssignMode(batchId) {
  S.assigningBatchId = batchId;
  rerenderCurrentView();
}

function cancelAssignMode() {
  S.assigningBatchId = null;
  rerenderCurrentView();
}

function assignBatchToSlot(loc, date, meal) {
  const batchId = S.assigningBatchId;
  if (!batchId) return;
  const batch = S.batches.find(d => d.id === batchId);
  if (!batch) { S.assigningBatchId = null; return; }
  // Check if already assigned to this slot
  const already = (batch.services || []).some(s => s.loc === loc && s.date === date && s.meal === meal);
  if (already) {
    toast('Already assigned to this slot');
    return;
  }
  if (!batch.services) batch.services = [];
  batch.services.push({ loc, date, meal });
  S.assigningBatchId = null;
  rebuildPlanner();
  scheduleSave();
  rerenderCurrentView();
  toast(`${batch.name} assigned to ${dateToDayName(date)} ${meal}`);
}
