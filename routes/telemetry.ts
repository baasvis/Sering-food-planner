// ─────────────────────────────────────────────────────────────────────────────
// TELEMETRY — event ingestion endpoint (no auth required)
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { prisma } from '../lib/db';
import { asyncHandler, errMsg } from '../lib/config';
import type { TelemetrySource, TelemetryType } from '../shared/types';

const router = express.Router();

// ── In-memory buffer for batched DB writes ──

interface BufferedEvent {
  source: string;
  type: string;
  name: string;
  data?: import('@prisma/client').Prisma.InputJsonValue;
  userId?: string;
  sessionId?: string;
  timestamp: Date;
}

const MAX_BUFFER = 10_000;
let buffer: BufferedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return;
  const events = buffer.splice(0, buffer.length);
  try {
    await prisma.telemetryEvent.createMany({ data: events });
  } catch (e: unknown) {
    console.error('Telemetry flush failed:', errMsg(e));
    // Re-add failed events if buffer has room
    if (buffer.length + events.length <= MAX_BUFFER) {
      buffer.unshift(...events);
    }
  }
}

export function startFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushBuffer().catch(() => {}); }, 60_000);
}

export function stopFlushTimer(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

/** Add a backend-originated event to the buffer */
export function addBackendEvent(type: TelemetryType, name: string, data?: Record<string, unknown>): void {
  if (buffer.length >= MAX_BUFFER) return;
  buffer.push({
    source: 'backend', type, name,
    data: data as import('@prisma/client').Prisma.InputJsonValue | undefined,
    timestamp: new Date(),
  });
}

// ── Rate limiting (simple in-memory, per IP) ──

const rateMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 20;       // requests per window
const RATE_WINDOW = 60_000;  // 1 minute

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

// Clean up stale rate limit entries every 5 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateMap) {
    if (now > entry.resetAt) rateMap.delete(ip);
  }
}, 5 * 60_000);
cleanupInterval.unref(); // Don't keep process alive for cleanup

// ── Validation ──

const VALID_SOURCES: Set<string> = new Set(['frontend', 'backend']);
const VALID_TYPES: Set<string> = new Set(['error', 'screen_view', 'feature_use', 'api_call']);

interface RawEvent {
  source?: string;
  type?: string;
  name?: string;
  data?: unknown;
  userId?: string;
  sessionId?: string;
  timestamp?: string;
}

function validateEvent(e: RawEvent): BufferedEvent | null {
  if (!e || typeof e !== 'object') return null;
  const source = typeof e.source === 'string' ? e.source : '';
  const type = typeof e.type === 'string' ? e.type : '';
  const name = typeof e.name === 'string' ? e.name.slice(0, 500) : '';
  if (!VALID_SOURCES.has(source) || !VALID_TYPES.has(type) || !name) return null;
  return {
    source: source as TelemetrySource,
    type: type as TelemetryType,
    name,
    data: e.data && typeof e.data === 'object' ? e.data as import('@prisma/client').Prisma.InputJsonValue : undefined,
    userId: typeof e.userId === 'string' ? e.userId.slice(0, 200) : undefined,
    sessionId: typeof e.sessionId === 'string' ? e.sessionId.slice(0, 100) : undefined,
    timestamp: e.timestamp ? new Date(e.timestamp) : new Date(),
  };
}

// ── POST /api/telemetry — accept batched events ──

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Rate limited' });
    return;
  }

  const events: RawEvent[] = Array.isArray(req.body) ? req.body.slice(0, 100) : [];
  if (events.length === 0) {
    res.status(400).json({ error: 'Expected array of events' });
    return;
  }

  let added = 0;
  for (const raw of events) {
    const event = validateEvent(raw);
    if (event && buffer.length < MAX_BUFFER) {
      buffer.push(event);
      added++;
    }
  }

  res.json({ ok: true, accepted: added });
}));

export default router;
