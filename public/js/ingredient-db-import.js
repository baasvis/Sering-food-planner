// ── INGREDIENT DATABASE — IMPORT / MIGRATION ─────────────────
// Split from ingredient-db.js. All functions are global.
// Depends on globals from ingredient-db.js: ingredientDbFull, ingredientDbFullLoaded,
//   supplierUploadData, loadIngredientDbFull
// Depends on globals from other files: apiPost, loadIngredientDb, renderOrders,
//   toast, toastError, esc, showModal, closeModal, S

// ── Supplier XLSX Upload + Import ────────────────────────────

async function handleSupplierUpload(file) {
  if (!file) return;
  toast('Parsing supplier file...');
  const formData = new FormData();
  formData.append('file', file);
  try {
    const r = await fetch('/api/ingredients/upload-supplier', { method: 'POST', body: formData });
    if (!r.ok) throw new Error((await r.json()).error || 'Upload failed');
    supplierUploadData = await r.json();
    toast(supplierUploadData.length + ' products parsed from file');
    renderOrders();
  } catch (e) {
    toastError('Upload failed: ' + e.message);
  }
}

function renderSupplierImportPanel() {
  if (!supplierUploadData || !supplierUploadData.length) return '';

  const existingCodes = new Set(ingredientDbFull.map(i => i.orderCode).filter(Boolean));
  const matched = supplierUploadData.filter(p => existingCodes.has(p.orderCode));
  const unmatched = supplierUploadData.filter(p => !existingCodes.has(p.orderCode) && p.recentOrders > 0);

  return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="font-weight:600;">Supplier Import: ${supplierUploadData.length} products parsed</span>
      <button class="btn btn-sm btn-danger" onclick="supplierUploadData=null;renderOrders()">Dismiss</button>
    </div>
    <p style="font-size:12px;color:var(--text2);margin:0 0 8px;">
      ${matched.length} match existing ingredients by order code.
      ${unmatched.length} new products with recent orders (not yet in database).
    </p>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="applySupplierUpdate()">
        Update ${matched.length} existing ingredients with latest prices/units
      </button>
    </div>
  </div>`;
}

async function applySupplierUpdate() {
  if (!supplierUploadData) return;
  const byCode = {};
  supplierUploadData.forEach(p => { byCode[p.orderCode] = p; });

  let updated = 0;
  ingredientDbFull.forEach(ing => {
    if (!ing.orderCode) return;
    const sup = byCode[ing.orderCode];
    if (!sup) return;

    // Check for price alert (>15% increase)
    if (ing.orderPrice && sup.price && sup.price > ing.orderPrice * 1.15) {
      ing.priceAlert = true;
    } else {
      ing.priceAlert = false;
    }

    ing.supplierName = sup.title;
    ing.orderPrice = sup.price;
    ing.orderUnit = sup.orderUnit;
    ing.orderUnitStandard = sup.orderUnitStandard;
    ing.orderAmountGrams = sup.orderAmountGrams;
    if (!ing.supplier) ing.supplier = 'Hanos';

    // Update price history
    if (sup.priceHistory && sup.priceHistory.length) {
      ing.priceHistory = sup.priceHistory;
    }

    // Update nutrition
    if (sup.nutrition) {
      ing.nutrition = sup.nutrition;
    }

    // Recalculate price per 100g
    if (ing.orderPrice && ing.orderAmountGrams > 0) {
      ing.pricePer100g = Math.round((ing.orderPrice / ing.orderAmountGrams) * 10000) / 100;
    }

    updated++;
  });

  if (updated === 0) { toast('No matching ingredients to update'); return; }

  toast('Saving ' + updated + ' updated ingredients...');
  try {
    await apiPost('/api/ingredients', ingredientDbFull);
    loadIngredientDb();
    supplierUploadData = null;
    renderOrders();
    toast(updated + ' ingredients updated with supplier data');
  } catch (e) {
    toastError('Save failed: ' + e.message);
  }
}

// ── Migration Modal ───────────────────────────────────────────

function openMigrationModal() {
  const modalHtml = `
    <div style="padding:20px;max-width:500px;">
      <h3 style="margin:0 0 16px;">Migrate Ingredient Database</h3>
      <p style="font-size:12px;color:var(--text2);margin:0 0 12px;">
        Upload the old ingredient CSV and Hanos CSV to rebuild the database. English names from the old DB will be preserved where order codes match. Only ingredients found in the Hanos list will be kept.
      </p>
      <div style="display:grid;gap:12px;">
        <div>
          <label class="ing-edit-label">Old Ingredient Database CSV</label>
          <input type="file" accept=".csv" id="migrate-old-csv" />
        </div>
        <div>
          <label class="ing-edit-label">Hanos CSV (prices export)</label>
          <input type="file" accept=".csv" id="migrate-hanos-csv" />
        </div>
        <div id="migrate-status" style="font-size:12px;color:var(--text2);"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-sm" onclick="closeModal()">Cancel</button>
          <button class="btn btn-sm" onclick="runMigration(true)">Dry run</button>
          <button class="btn btn-sm" style="background:var(--green);color:white;" onclick="runMigration(false)">Run migration</button>
        </div>
      </div>
    </div>`;
  showModal(modalHtml);
}

async function runMigration(dryRun) {
  const oldFile = document.getElementById('migrate-old-csv').files[0];
  const hanosFile = document.getElementById('migrate-hanos-csv').files[0];
  if (!hanosFile) { toastError('Hanos CSV is required'); return; }

  const status = document.getElementById('migrate-status');
  status.textContent = dryRun ? 'Running dry run...' : 'Running migration...';

  const formData = new FormData();
  if (oldFile) formData.append('oldCsv', oldFile);
  formData.append('hanosCsv', hanosFile);

  try {
    const url = '/api/ingredients/migrate' + (dryRun ? '?dryRun=true' : '');
    const r = await fetch(url, { method: 'POST', body: formData });
    if (!r.ok) throw new Error((await r.json()).error || 'Migration failed');
    const result = await r.json();

    if (dryRun) {
      status.innerHTML = `<strong>Dry run result:</strong><br>
        Total: ${result.total} ingredients<br>
        Matched (old name kept): ${result.matched}<br>
        Hanos only (Dutch name): ${result.hanosOnly}<br>
        Active (ordered in last year): ${result.active}<br>
        Inactive: ${result.inactive}<br>
        <span style="color:var(--green);">Ready to run for real.</span>`;
    } else {
      status.innerHTML = `<strong style="color:var(--green);">Migration complete!</strong><br>
        ${result.total} ingredients saved. ${result.matched} matched with old DB.`;
      ingredientDbFullLoaded = false;
      loadIngredientDb();
      toast('Migration complete: ' + result.total + ' ingredients');
    }
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red);">Error: ${esc(e.message)}</span>`;
    toastError('Migration failed: ' + e.message);
  }
}
