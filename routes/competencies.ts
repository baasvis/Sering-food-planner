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
import { prisma, dbAppendLog, withWriteLock, checkId } from '../lib/db';
import { addBackendEvent } from './telemetry';
import { isStaffLeadEmail } from './auth';
import { syncChunksFromNotion } from '../lib/notion-sync';

const router = express.Router();

// GET /api/competencies — screen-load payload. The chunk library, the full
// people list (active + deactivated — the grid filters to active client-side,
// the admin view manages all), and the full teaching-event ledger. The
// people×chunks grid is computed client-side from these three. `isStaffLead`
// drives whether the Admin entry shows.
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const [chunks, people, events] = await Promise.all([
    prisma.chunk.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.person.findMany({ orderBy: { name: 'asc' } }),
    prisma.teachingEvent.findMany({ orderBy: { createdAt: 'desc' } }),
  ]);
  res.json({ chunks, people, events, isStaffLead: isStaffLeadEmail(req.user?.email) });
}));

// POST /api/competencies/events — log a teaching event. Trust by default:
// no check that teacher != learner, no duplicate guard, no date sanity.
router.post('/events', asyncHandler(async (req: Request, res: Response) => {
  const { id, chunkId, teacherId, learnerId, date, notes } = req.body;
  if (!id || !chunkId || !teacherId || !learnerId || !date) {
    return res.status(400).json({ error: 'id, chunkId, teacherId, learnerId and date are required' });
  }
  // Defence-in-depth: ids are client-supplied keys. Kiosk "trust by default" is
  // about business logic (no teacher!=learner check), not letting arbitrary
  // strings into the data layer — validate the charset (audit SEC-2/ARCH-7).
  const idErr = checkId(id, 'id') || checkId(chunkId, 'chunkId')
    || checkId(teacherId, 'teacherId') || checkId(learnerId, 'learnerId');
  if (idErr) return res.status(400).json({ error: idErr });
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid date (expected YYYY-MM-DD)' });
  }
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 2000)) {
    return res.status(400).json({ error: 'invalid notes' });
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

// DELETE /api/competencies/events/:id — remove a teaching event logged by
// mistake. Staff-lead gated: a correction, not a kiosk action.
router.delete('/events/:id', asyncHandler(async (req: Request, res: Response) => {
  if (!isStaffLeadEmail(req.user?.email)) {
    return res.status(403).json({ error: 'Staff-lead access required' });
  }
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const eventId = req.params.id as string;
  await withWriteLock(() => prisma.teachingEvent.delete({ where: { id: eventId } }));
  dbAppendLog(user.email, user.name, 'teaching-event', `deleted teaching event ${eventId}`);
  res.json({ ok: true });
}));

// POST /api/competencies/people — add a staff name. Not staff-lead-gated:
// this is the kiosk "+ add a name" control, open to any signed-in user,
// like logging an event.
router.post('/people', asyncHandler(async (req: Request, res: Response) => {
  const { id, name, location } = req.body;
  if (!id || !name || !String(name).trim()) {
    return res.status(400).json({ error: 'id and name are required' });
  }
  const idErr = checkId(id, 'id');
  if (idErr) return res.status(400).json({ error: idErr });
  const personName = String(name).trim();
  if (personName.length > 100) return res.status(400).json({ error: 'name too long (max 100)' });
  if (location !== undefined && location !== 'west' && location !== 'centraal') {
    return res.status(400).json({ error: 'invalid location' });
  }
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const person = await withWriteLock(() => prisma.person.create({
    data: { id, name: personName, location: location || 'centraal' },
  }));
  dbAppendLog(user.email, user.name, 'competency-person', `added "${person.name}"`);
  res.json(person);
}));

// PATCH /api/competencies/people/:id — rename or (de)activate a person.
// Staff-lead gated: the kiosk "+ add a name" is open to anyone, but editing
// the roster is a content-management action. Deactivate over delete — a
// person may carry teaching history.
router.patch('/people/:id', asyncHandler(async (req: Request, res: Response) => {
  if (!isStaffLeadEmail(req.user?.email)) {
    return res.status(403).json({ error: 'Staff-lead access required' });
  }
  const { name, active } = req.body;
  const data: { name?: string; active?: boolean } = {};
  if (typeof name === 'string' && name.trim()) {
    const nm = name.trim();
    if (nm.length > 100) return res.status(400).json({ error: 'name too long (max 100)' });
    data.name = nm;
  }
  if (typeof active === 'boolean') data.active = active;
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'name or active is required' });
  }
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  const person = await withWriteLock(() => prisma.person.update({
    where: { id: req.params.id as string },
    data,
  }));
  const tag = data.active === false ? ' (deactivated)'
    : data.active === true ? ' (reactivated)' : '';
  dbAppendLog(user.email, user.name, 'competency-person', `updated "${person.name}"${tag}`);
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
      ? `synced ${report.synced.length}, warned ${report.warned.length}, flagged ${report.flagged.length}`
      : `failed: ${report.error}`);
  if (!report.ok) {
    const notConfigured = !!report.error && report.error.includes('not configured');
    return res.status(notConfigured ? 503 : 502).json(report);
  }
  res.json(report);
}));

export default router;
