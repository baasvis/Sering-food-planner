// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SHEETS CLIENT — EXTERNAL RECIPE SHEET READING ONLY
// ─────────────────────────────────────────────────────────────────────────────

const { google } = require('googleapis');
const { CONFIG } = require('./config');

function getSheetsClient() {
  try {
    const credentials = JSON.parse(CONFIG.GOOGLE_CREDENTIALS);
    if (!credentials.client_email) return null;
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
  } catch (e) {
    console.error('Could not create Sheets client:', e.message);
    return null;
  }
}

module.exports = { getSheetsClient };
