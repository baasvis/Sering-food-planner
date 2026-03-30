// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SHEETS CLIENT — EXTERNAL RECIPE SHEET READING ONLY
// ─────────────────────────────────────────────────────────────────────────────

import { google } from 'googleapis';
import { CONFIG } from './config';

export function getSheetsClient() {
  try {
    const credentials = JSON.parse(CONFIG.GOOGLE_CREDENTIALS);
    if (!credentials.client_email) return null;
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
  } catch (e: any) {
    console.error('Could not create Sheets client:', e.message);
    return null;
  }
}
