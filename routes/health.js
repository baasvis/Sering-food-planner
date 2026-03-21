const router = require('express').Router();
const { CONFIG } = require('../lib/config');

router.get('/', (req, res) => {
  let creds = {};
  try { creds = JSON.parse(CONFIG.GOOGLE_CREDENTIALS); } catch (e) {}
  res.json({
    status: 'ok',
    sheetsConfigured: !!creds.client_email,
    dbSheetConfigured: !!CONFIG.DB_SHEET_ID,
    authConfigured: !!CONFIG.GOOGLE_CLIENT_ID,
    googleClientId: CONFIG.GOOGLE_CLIENT_ID || null,
    allowedEmails: CONFIG.ALLOWED_EMAILS.length,
  });
});

module.exports = router;
