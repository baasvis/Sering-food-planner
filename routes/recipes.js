const router = require('express').Router();
const { CONFIG } = require('../lib/config');
const { getSheetsClient, readTab, writeTab, ensureTabsExist, withWriteLock, dbAppendLog, RECIPE_INDEX_HEADERS, rowToRecipeIndex, recipeIndexToRow } = require('../lib/sheets');

router.get('/recipe-index', async (req, res) => {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return res.json([]);
  try {
    await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['recipe_index']);
    const rows = await readTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index');
    res.json(rows.map(rowToRecipeIndex));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/recipe-index', async (req, res) => {
  const recipe = req.body;
  if (!recipe || !recipe.id || !recipe.name) return res.status(400).json({ error: 'id and name required' });
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      await ensureTabsExist(sheets, CONFIG.DB_SHEET_ID, ['recipe_index']);
      const existing = await readTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index');
      const all = existing.map(rowToRecipeIndex);
      const idx = all.findIndex(r => r.id === recipe.id);
      if (idx >= 0) all[idx] = recipe;
      else all.push(recipe);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index', RECIPE_INDEX_HEADERS, all.map(recipeIndexToRow));
    });
    const user = req.user || { email: 'anonymous', name: 'Anonymous' };
    dbAppendLog(user.email, user.name, 'recipe-index', `saved "${recipe.name}"`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/recipe-index/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await withWriteLock(async () => {
      const sheets = getSheetsClient();
      if (!sheets || !CONFIG.DB_SHEET_ID) throw new Error('Sheets not configured');
      const existing = await readTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index');
      const all = existing.map(rowToRecipeIndex).filter(r => r.id !== id);
      await writeTab(sheets, CONFIG.DB_SHEET_ID, 'recipe_index', RECIPE_INDEX_HEADERS, all.map(recipeIndexToRow));
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/recipe', async (req, res) => {
  const { sheetId } = req.query;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(sheetId)) return res.status(400).json({ error: 'Invalid sheetId format' });

  const sheets = getSheetsClient();
  if (!sheets) return res.status(503).json({ error: 'Google Sheets not configured' });
  try {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId, ranges: ['C1','B3','D3','F3','H3','K2','K4','O3','O4','J6:N40','X6:X40','K6:K40'],
    });
    const vals = response.data.valueRanges;
    const dishName    = vals[0].values?.[0]?.[0] || '';
    const serving     = parseFloat((vals[1].values?.[0]?.[0]||'280').toString().replace(',','.')) || 280;
    const allergens   = (vals[2].values?.[0]?.[0]||'').split(',').map(s=>s.trim()).filter(Boolean);
    const servingTemp = vals[3].values?.[0]?.[0] || '';
    const structure   = vals[4].values?.[0]?.[0] || '';
    const dishType    = vals[5].values?.[0]?.[0] || '';
    const recipeVol   = parseFloat((vals[6].values?.[0]?.[0]||'0').toString().replace(',','.')) || 0;
    const seasonality = vals[7].values?.[0]?.[0] || '';
    const costPerServing = vals[8].values?.[0]?.[0] || '';
    const ingRows     = vals[9].values || [];
    const sourceRows  = vals[10].values || [];
    const unitRows    = vals[11].values || [];
    const ingredients = [];
    ingRows.forEach((row, i) => {
      if (!row[0] || !row[2]) return;
      const rawAmt = parseFloat(String(row[2]).replace(',','.'));
      if (!rawAmt || rawAmt <= 0) return;
      if (row[0].length > 80) return;
      const afterCooking = row[3] ? parseFloat(String(row[3]).replace(',','.')) : null;
      const amount = (afterCooking && afterCooking > 0) ? afterCooking : rawAmt;
      const unit = (unitRows[i] && unitRows[i][0]) || 'Grams';
      ingredients.push({
        name: row[0],
        amount,
        unit,
        source: (sourceRows[i] && sourceRows[i][0]) || '',
      });
    });
    res.json({ dishName, serving, allergens, servingTemp, structure, dishType, recipeVolume: recipeVol, seasonality, costPerServing, ingredients });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
