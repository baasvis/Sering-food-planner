// ─────────────────────────────────────────────────────────────────────────────
// DE SERING FOOD PLANNER — EXPRESS APP
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import compression from 'compression';
import helmet from 'helmet';

const app = express();
app.set('trust proxy', 1);

// Audit S7: baseline security headers via helmet. Two defaults are turned
// off because they would break the current app:
//   - contentSecurityPolicy: the app uses inline `onclick=""` everywhere
//     (S2 follow-up — switch to delegated handlers, then enable a strict
//     CSP). With the default CSP enabled, the planner won't render.
//   - crossOriginEmbedderPolicy: the login screen loads the Google Sign-In
//     SDK from accounts.google.com which is not COEP-compatible.
// And one is loosened:
//   - crossOriginOpenerPolicy: `same-origin-allow-popups` instead of the
//     `same-origin` default. Google Sign-In opens accounts.google.com in a
//     popup and posts the credential back via window.opener; strict COOP
//     severs that handle and the popup renders blank.
// Everything else stays on:
//   - HSTS (1y, includeSubDomains)
//   - X-Frame-Options: SAMEORIGIN — blocks clickjacking on destructive actions
//   - X-Content-Type-Options: nosniff — defense-in-depth for the photo path (S8)
//   - Referrer-Policy: same-origin (per the audit, less restrictive than the
//     default `no-referrer` so internal links keep working as expected)
//   - Cross-Origin-Resource-Policy: cross-origin so the photo endpoint can
//     be embedded if a future feature ever needs it; same-origin would also
//     be fine but cross-origin is the safer non-breaking default
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'same-origin' },
}));

// gzip compression for JSON + static assets. Skip SSE (text/event-stream
// must stream un-buffered, otherwise clients never see events until the
// response buffer flushes). /api/data in particular is the single most
// frequently called endpoint (352 calls/day, 888ms avg) and has a JSON
// payload with large ingredient/recipe arrays — compression is the single
// biggest win available here without redesigning the endpoint.
app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith('/api/events')) return false;
    // Recipe AI chat is also SSE — must not buffer.
    if (req.path.startsWith('/api/recipe-ai/chat')) return false;
    return compression.filter(req, res);
  },
}));

app.use(express.json({ limit: '2mb' }));

// Static files — serve built client in production, public/ in dev
// In production, compiled server runs from dist/server/, so __dirname = dist/server/
// Vite builds client to dist/client/, one level up: path.join(__dirname, '..', 'client')
// In dev, tsx runs from project root, so __dirname = project root, public/ is correct
const clientDir = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, '..', 'client')
  : path.join(__dirname, 'public');
app.use(express.static(clientDir, {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Vite emits hashed, content-addressable assets under /assets/*.
    // Treat them as immutable — one year cache eliminates revalidation
    // round-trips that currently cost 600–900ms on / GET (AI insight #21/#13).
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // index.html and other non-hashed files: revalidate on every load.
      // Express's ETag handling means the body is only re-sent when content
      // actually changed, so there's still no perf loss. The alternative
      // (max-age > 0) risks serving a cached index.html that points at
      // hashed asset filenames deleted by a subsequent deploy.
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ── API response time telemetry ──

import telemetryRouter, { addBackendEvent } from './routes/telemetry';

app.use('/api', (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    // Skip telemetry's own endpoint to avoid recursion
    if (req.path === '/telemetry' || req.path === '/telemetry/') return;
    addBackendEvent('api_call', req.path, {
      method: req.method,
      statusCode: res.statusCode,
      duration: Date.now() - start,
    });
  });
  next();
});

// ── Mount routes ──

// Telemetry endpoint — no auth required (must work even if auth is broken)
app.use('/api/telemetry', telemetryRouter);

// Coverage snapshot — bearer-token auth (COVERAGE_API_KEY). Mounted before
// requireAuth so remote agents can fetch without a session cookie.
import coverageRouter from './routes/coverage';
app.use('/api/coverage', coverageRouter);

import authRouter, { requireAuth } from './routes/auth';
app.use('/api/auth', authRouter);
app.use('/api', requireAuth);

import dataRouter from './routes/data';
import batchesRouter from './routes/batches';
import recipesRouter from './routes/recipes';
import ingredientsRouter from './routes/ingredients';
import guestsRouter from './routes/guests';
import inventoryRouter from './routes/inventory';
import feedbackRouter from './routes/feedback';
import hanosRouter from './routes/hanos';
import financeRouter from './routes/finance';
import eventsRouter from './routes/events';
import healthRouter from './routes/health';

app.use('/api/data',              dataRouter);
app.use('/api/batches',           batchesRouter);
app.use('/api',                   recipesRouter);
app.use('/api/ingredients',       ingredientsRouter);
app.use('/api',                   guestsRouter);
app.use('/api',                   inventoryRouter);
app.use('/api/feedback',          feedbackRouter);
app.use('/api/hanos',             hanosRouter);
app.use('/api/finance',           financeRouter);
app.use('/api/events',            eventsRouter);
app.use('/api/health',            healthRouter);

import adminRouter from './routes/admin';
app.use('/api/admin',             adminRouter);

import recipeAiRouter from './routes/recipe-ai';
app.use('/api/recipe-ai',         recipeAiRouter);

// ── Global error handler ──

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as Error & { status?: number }).status || 500;
  // Only log stack traces for unexpected server errors, not client errors (4xx)
  if (status >= 500) {
    console.error('Unhandled error:', err.stack || err.message);
    // Track backend errors in telemetry
    addBackendEvent('error', err.message, {
      stack: err.stack?.slice(0, 1000),
      status,
      path: _req.path,
      method: _req.method,
    });
  }
  // In production, don't leak internal error messages for 500s
  const message = status >= 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;
  res.status(status).json({ error: message });
});

export default app;
