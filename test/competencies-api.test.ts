// Competencies API — round-trip: add staff names, log a teaching event, read
// it back through the screen-load endpoint. Trust-by-default on business logic
// (any teacher/learner/chunk/date combination), but ids/location/date are
// charset/format-validated as a security boundary (audit SEC-2 / ARCH-7).

try { require('dotenv').config(); } catch (_e) { /* noop */ }
const request = require('supertest');
const app = require('../app').default;
const { prisma } = require('../lib/db');

const T = 'test-' + Date.now() + '-';
const chunkId = T + 'chunk';
const teacherId = T + 'teacher';
const learnerId = T + 'learner';
const eventId = T + 'event';

let cookie: string[];

beforeAll(async () => {
  const login = await request(app).post('/api/auth/google').send({ idToken: 'dev' });
  cookie = login.headers['set-cookie'] as unknown as string[];
  await prisma.chunk.create({
    data: {
      id: chunkId, name: 'Test Chunk', station: 'Test Station', type: 'practical',
      prerequisites: [], requiredFor: [],
    },
  });
});

afterAll(async () => {
  // teaching_events first — FK references chunks + people (ON DELETE RESTRICT).
  await prisma.teachingEvent.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.chunk.deleteMany({ where: { id: { startsWith: T } } });
  await prisma.$disconnect();
});

describe('Competencies API', () => {
  it('POST /api/competencies/people — adds staff names', async () => {
    const r1 = await request(app).post('/api/competencies/people')
      .set('Cookie', cookie).send({ id: teacherId, name: 'Test Teacher' });
    expect(r1.status).toBe(200);
    expect(r1.body.name).toBe('Test Teacher');
    const r2 = await request(app).post('/api/competencies/people')
      .set('Cookie', cookie).send({ id: learnerId, name: 'Test Learner' });
    expect(r2.status).toBe(200);
  });

  it('POST /api/competencies/events — logs a teaching event', async () => {
    const res = await request(app).post('/api/competencies/events')
      .set('Cookie', cookie)
      .send({ id: eventId, chunkId, teacherId, learnerId, date: '2099-01-15', notes: 'round-trip note' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(eventId);
    expect(res.body.learnerId).toBe(learnerId);
  });

  it('GET /api/competencies — round-trips chunks, people and the logged event', async () => {
    const res = await request(app).get('/api/competencies').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const chunks: Array<{ id: string }> = res.body.chunks;
    const people: Array<{ id: string }> = res.body.people;
    const events: Array<{ id: string; teacherId: string; learnerId: string; chunkId: string; date: string; notes: string }> = res.body.events;
    expect(chunks.some(c => c.id === chunkId)).toBe(true);
    expect(people.some(p => p.id === teacherId)).toBe(true);
    expect(people.some(p => p.id === learnerId)).toBe(true);
    const ev = events.find(e => e.id === eventId);
    expect(ev).toBeDefined();
    if (!ev) return;
    expect(ev.teacherId).toBe(teacherId);
    expect(ev.learnerId).toBe(learnerId);
    expect(ev.chunkId).toBe(chunkId);
    expect(ev.date).toBe('2099-01-15');
    expect(ev.notes).toBe('round-trip note');
  });
});

describe('Competencies API — input validation (audit SEC-2 / ARCH-7)', () => {
  it('POST /events rejects an id with an invalid charset', async () => {
    const res = await request(app).post('/api/competencies/events')
      .set('Cookie', cookie)
      .send({ id: 'bad id!', chunkId, teacherId, learnerId, date: '2099-01-15' });
    expect(res.status).toBe(400);
  });
  it('POST /events rejects a malformed date', async () => {
    const res = await request(app).post('/api/competencies/events')
      .set('Cookie', cookie)
      .send({ id: T + 'ev-bad', chunkId, teacherId, learnerId, date: '15-01-2099' });
    expect(res.status).toBe(400);
  });
  it('POST /people rejects an invalid location', async () => {
    const res = await request(app).post('/api/competencies/people')
      .set('Cookie', cookie)
      .send({ id: T + 'p-badloc', name: 'X', location: 'mars' });
    expect(res.status).toBe(400);
  });
  it('POST /people rejects an id with an invalid charset', async () => {
    const res = await request(app).post('/api/competencies/people')
      .set('Cookie', cookie)
      .send({ id: 'bad id!', name: 'X' });
    expect(res.status).toBe(400);
  });
});
