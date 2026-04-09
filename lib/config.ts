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
  HANOS_CLIENT_SECRET: process.env.HANOS_CLIENT_SECRET || '',
  HANOS_USER_WEST: process.env.HANOS_USER_WEST || '',
  HANOS_PASS_WEST: process.env.HANOS_PASS_WEST || '',
  HANOS_USER_CENTRAAL: process.env.HANOS_USER_CENTRAAL || '',
  HANOS_PASS_CENTRAAL: process.env.HANOS_PASS_CENTRAAL || '',
};

// Extract error message safely from unknown caught values
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error';
}

// Wrap async route handlers so unhandled rejections are forwarded to Express error handler
import type { Request, Response, NextFunction, RequestHandler } from 'express';
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
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
