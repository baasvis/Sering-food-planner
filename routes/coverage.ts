// ─────────────────────────────────────────────────────────────────────────────
// COVERAGE — exposes the telemetry-driven e2e coverage snapshot via HTTPS so
// remote agents (which can't reach Railway's custom DB ports) can fetch it.
//
// Bearer-token auth via COVERAGE_API_KEY env var. Endpoint is mounted BEFORE
// /api requireAuth so it doesn't need a session cookie.
//
// If COVERAGE_API_KEY is not set, the endpoint returns 503 — no anonymous
// access. The data isn't sensitive (no PII, just usage aggregates) but it's
// not public either.
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/db';
import { asyncHandler } from '../lib/config';
import { analyzeCoverage } from '../lib/telemetry-coverage';

const router = express.Router();

router.get('/snapshot', asyncHandler(async (req: Request, res: Response) => {
  const apiKey = process.env.COVERAGE_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'COVERAGE_API_KEY not configured on server' });
    return;
  }
  const auth = req.header('authorization') ?? '';
  // Audit S6: timing-safe equality. The risk is small (TLS jitter dominates
  // the timing channel) but the swap is cheap. timingSafeEqual throws on
  // length mismatch, so guard with a length check first; the length itself
  // is not secret.
  const expected = `Bearer ${apiKey}`;
  const authBuf = Buffer.from(auth);
  const expectedBuf = Buffer.from(expected);
  if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const daysBack = Math.max(1, Math.min(90, Number(req.query.days ?? 14)));
  const topN = Math.max(1, Math.min(100, Number(req.query.top ?? 20)));
  const minLength = Math.max(1, Math.min(20, Number(req.query.min ?? 3)));

  const snapshot = await analyzeCoverage(prisma, { daysBack, topN, minLength });
  res.json(snapshot);
}));

export default router;
