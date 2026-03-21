const router = require('express').Router();
const { CONFIG } = require('../lib/config');
const { getSheetsClient } = require('../lib/sheets');

router.post('/', async (req, res) => {
  const { type, text, screen, user, timestamp, userAgent } = req.body;
  if (!text) return res.status(400).json({ error: 'Feedback text required' });

  const sheets = getSheetsClient();
  if (!sheets || !CONFIG.DB_SHEET_ID) return res.status(503).json({ error: 'Google Sheets not configured' });

  try {
    // Ensure 'feedback' tab exists
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: CONFIG.DB_SHEET_ID, fields: 'sheets.properties.title',
    });
    const tabs = meta.data.sheets.map(s => s.properties.title);
    if (!tabs.includes('feedback')) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: CONFIG.DB_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'feedback' } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: CONFIG.DB_SHEET_ID,
        range: 'feedback!A1:F1',
        valueInputOption: 'RAW',
        requestBody: { values: [['Timestamp', 'User', 'Type', 'Screen', 'Feedback', 'User Agent']] },
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.DB_SHEET_ID,
      range: 'feedback!A:F',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[timestamp || new Date().toISOString(), user || 'anonymous', type || 'general', screen || '', text, userAgent || '']],
      },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('Feedback save error:', e.message);
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

module.exports = router;
