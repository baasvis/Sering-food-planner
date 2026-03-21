const router = require('express').Router();
const fs = require('fs');
const { CONFIG, STD_INV_FILE, PREP_CHECKLIST_FILE } = require('../lib/config');
const { getSheetsClient, readTab } = require('../lib/sheets');

// ── Standard Inventory ──

router.get('/standard-inventory', (req, res) => {
  try {
    const items = fs.existsSync(STD_INV_FILE) ? JSON.parse(fs.readFileSync(STD_INV_FILE, 'utf8')) : [];
    res.json(items);
  } catch (e) {
    res.json([]);
  }
});

router.post('/standard-inventory', (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected array' });
  try {
    fs.writeFileSync(STD_INV_FILE, JSON.stringify(items, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Prep Checklist ──

function loadPrepChecklistFile() {
  try {
    if (fs.existsSync(PREP_CHECKLIST_FILE))
      return JSON.parse(fs.readFileSync(PREP_CHECKLIST_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function savePrepChecklistFile(data) {
  // Auto-expire entries older than 3 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(data)) {
    const dash = key.indexOf('-');
    const isoDate = key.slice(dash + 1);
    if (isoDate < cutoffStr) delete data[key];
  }
  fs.writeFileSync(PREP_CHECKLIST_FILE, JSON.stringify(data, null, 2));
}

router.get('/prep-checklist', (req, res) => {
  const { loc, date } = req.query;
  if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
  const data = loadPrepChecklistFile();
  res.json(data[`${loc}-${date}`] || []);
});

router.post('/prep-checklist', (req, res) => {
  const { loc, date, checked } = req.body;
  if (!loc || !date) return res.status(400).json({ error: 'loc and date required' });
  const data = loadPrepChecklistFile();
  data[`${loc}-${date}`] = Array.isArray(checked) ? checked : [];
  savePrepChecklistFile(data);
  res.json({ ok: true });
});

// ── Activity Log ──

router.get('/log', async (req, res) => {
  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return res.json([]);
  try {
    const rows = await readTab(sheets, CONFIG.DB_SHEET_ID, 'log');
    res.json(rows.slice(-50).reverse());
  } catch (e) { res.json([]); }
});

module.exports = router;
