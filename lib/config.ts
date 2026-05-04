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
  // Audit S3/S4: explicit auth-mode opt-in. When 'production', the dev-mode
  // bypass in routes/auth.ts is disabled and server.ts refuses to boot if
  // GOOGLE_CLIENT_ID or ALLOWED_EMAILS is empty. Decoupled from NODE_ENV so
  // local `npm run preview` (NODE_ENV=production for serving dist/client) can
  // keep using the dev-login flow. Default 'dev'.
  AUTH_MODE: (process.env.AUTH_MODE === 'production' ? 'production' : 'dev') as 'production' | 'dev',
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

// Redact credential-like substrings from error text before it reaches HTTP
// responses, telemetry payloads, or stderr captures. Upstream APIs occasionally
// echo the request (Hanos OAuth, Tebi's Playwright stderr) and could leak the
// password/secret/token in their error bodies. Use whenever rendering an
// error message that came from an external system.
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // Authorization header schemes — preserve the scheme name, hide the value.
  [/(\bBearer\s+)[A-Za-z0-9._\-+/=]+/gi, '$1***'],
  [/(\bBasic\s+)[A-Za-z0-9+/=]+/gi, '$1***'],
  // key=value / key: value patterns. "authorization" is intentionally NOT in
  // this list — Bearer/Basic above handle the realistic auth-header cases,
  // and adding it here would double-redact and hide the scheme name.
  [/(\b(?:password|passwd|secret|token|client_secret|api[_-]?key)\b\s*[:=]\s*)([^\s,&;"'}]+)/gi,
   '$1***'],
];
export function redactSecrets(s: string): string {
  if (!s) return s;
  let out = s;
  for (const [re, rep] of REDACT_PATTERNS) out = out.replace(re, rep);
  return out;
}
export function safeErrMsg(e: unknown): string {
  return redactSecrets(errMsg(e));
}

// Typed error with HTTP status code — caught by global error handler in app.ts
export class AppError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

// Wrap async route handlers so unhandled rejections are forwarded to Express error handler
import type { Request, Response, NextFunction, RequestHandler } from 'express';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express handlers may return res.status().json() which is Response, not void
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler {
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
