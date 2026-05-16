// ─────────────────────────────────────────────────────────────────────────────
// COMPETENCIES — peer-teaching tracker.
//
// Three entities: chunks (teachable units), people (staff), teaching events
// (the accumulating public ledger). Competence is derived from the event
// history — there is no stored "is competent" flag.
//
// Trust by default (kiosk model): writes are not defensively validated.
// POST /events accepts any teacher/learner/chunk/date combination — mistakes
// are caught socially via the public ledger, not by the server.
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { asyncHandler } from '../lib/config';
import { prisma, dbAppendLog, withWriteLock } from '../lib/db';
import { addBackendEvent } from './telemetry';
import { isStaffLeadEmail } from './auth';
import { syncChunksFromNotion } from '../lib/notion-sync';

const router = express.Router();

// GET /api/competencies — screen-load payload. The chunk library, the active
// people list, and the full teaching-event ledger. The people×chunks grid is
// computed client-side from these three.
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const [chunks, people, events] = await Promise.all([
    prisma.chunk.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.person.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    prisma.teachingEvent.findMany({ orderBy: { createdAt: 'desc' } }),
  ]);
  res.json({ chunks, people, events });
}));

// POST /api/competencies/events — log a teaching event. Trust by default:
// no check that teacher != learner, no duplicate guard, no date sanity.
router.post('/events', asyncHandler(async (req: Request, res: Response) => {
  const { id, chunkId, teacherId, learnerId, date, notes } = req.body;
  if (!id || !chunkId || !teacherId || !learnerId || !date) {
    return res.status(400).json({ error: 'id, chunkId, teacherId, learnerId and date are required' });
  }
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const event = await withWriteLock(() => prisma.teachingEvent.create({
    data: {
      id, chunkId, teacherId, learnerId, date,
      notes: notes || '',
      createdByEmail: user.email,
      createdByName: user.name,
    },
  }));
  dbAppendLog(user.email, user.name, 'teaching-event', `logged teaching event ${id}`);
  addBackendEvent('feature_use', 'competency_log_event', { chunkId });
  res.json(event);
}));

// POST /api/competencies/people — add a staff name. Not staff-lead-gated:
// this is the kiosk "+ add a name" control, open to any signed-in user,
// like logging an event.
router.post('/people', asyncHandler(async (req: Request, res: Response) => {
  const { id, name, location } = req.body;
  if (!id || !name || !String(name).trim()) {
    return res.status(400).json({ error: 'id and name are required' });
  }
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const person = await withWriteLock(() => prisma.person.create({
    data: { id, name: String(name).trim(), location: location || 'centraal' },
  }));
  dbAppendLog(user.email, user.name, 'competency-person', `added "${person.name}"`);
  res.json(person);
}));

// POST /api/competencies/sync-chunks — pull the chunk library from Notion.
// Staff-lead gated: a content-management action.
router.post('/sync-chunks', asyncHandler(async (req: Request, res: Response) => {
  if (!isStaffLeadEmail(req.user?.email)) {
    return res.status(403).json({ error: 'Staff-lead access required' });
  }
  const report = await syncChunksFromNotion();
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'competency-sync',
    report.ok
      ? `synced ${report.synced.length}, flagged ${report.flagged.length}`
      : `failed: ${report.error}`);
  if (!report.ok) {
    const notConfigured = !!report.error && report.error.includes('not configured');
    return res.status(notConfigured ? 503 : 502).json(report);
  }
  res.json(report);
}));

export default router;
