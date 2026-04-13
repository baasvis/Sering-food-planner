// ─────────────────────────────────────────────────────────────────────────────
// DE SERING FOOD PLANNER — EXPRESS APP
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response, NextFunction } from 'express';
import path from 'path';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// Static files — serve built client in production, public/ in dev
// In production, compiled server runs from dist/server/, so __dirname = dist/server/
// Vite builds client to dist/client/, one level up: path.join(__dirname, '..', 'client')
// In dev, tsx runs from project root, so __dirname = project root, public/ is correct
const clientDir = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, '..', 'client')
  : path.join(__dirname, 'public');
app.use(express.static(clientDir));

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
