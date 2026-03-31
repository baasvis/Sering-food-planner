// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';

export const INGREDIENTS_SEED = path.join(__dirname, '..', 'seeds', 'ingredients.json');
export const STD_INV_SEED = path.join(__dirname, '..', 'seeds', 'standard-inventory.json');

export const CONFIG = {
  GOOGLE_CREDENTIALS: process.env.GOOGLE_CREDENTIALS || '{}',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  ALLOWED_EMAILS: (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
};

// Extract error message safely from unknown caught values
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error';
}

// Cookie options: secure when behind HTTPS (production), lax otherwise (dev)
export function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.RAILWAY_ENVIRONMENT === 'production' || !!process.env.RAILWAY_PUBLIC_DOMAIN,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}
