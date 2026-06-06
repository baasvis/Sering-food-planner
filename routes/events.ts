// ─────────────────────────────────────────────────────────────────────────────
// SERVER-SENT EVENTS — Real-time sync between clients
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { BATCH_SCHEMA_VERSION } from '../shared/types';

const router = express.Router();

// Connected SSE clients: Map<clientId, { res, user }>
const clients = new Map<number, { res: Response; user: { email: string; name: string } }>();
let nextClientId = 1;

// ── SSE endpoint: clients connect here to receive live updates ──
router.get('/', (req: Request, res: Response) => {
  const clientId = nextClientId++;
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

  // Keep-alive every 30s. Sent as a real data event (not an SSE comment) so
  // EventSource fires onmessage on the client — the client uses that to bump
  // its _lastEventAt timestamp and skip the health-check-driven reconnect.
  const keepAlive = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
  }, 30000);

  clients.set(clientId, { res, user });
  console.log(`SSE: client ${clientId} connected (${user.name}) — ${clients.size} total`);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(clientId);
    console.log(`SSE: client ${clientId} disconnected — ${clients.size} total`);
  });
});

// ── Broadcast a patch to all clients EXCEPT the sender ──
//
// schemaVersion is injected first so the spread of `data` can override it
// for tests; in normal use no caller passes the field. The frontend's
// applyRemotePatch (public/js/utils.ts) compares against its bundle's
// BATCH_SCHEMA_VERSION constant and force-reloads on mismatch — this is
// the deploy-window safety net for stale browser tabs (audit S4).
export function broadcast(senderEmail: string, eventType: string, data: Record<string, unknown>) {
  const payload = JSON.stringify({ type: eventType, schemaVersion: BATCH_SCHEMA_VERSION, ...data });
  const message = `data: ${payload}\n\n`;

  for (const [id, client] of clients) {
    if (client.user.email === senderEmail) continue;
    try {
      client.res.write(message);
    } catch (_e) {
      clients.delete(id);
    }
  }
}

// ── Send an event to specific users by email ──
//
// Unlike broadcast(), this targets a set of emails instead of excluding a
// sender. Used to push a "permissions-changed" signal to the users whose role
// (or whose role's matrix) a director just edited, so their tab refreshes its
// access without a re-login.
export function sendToEmails(emails: string[], eventType: string, data: Record<string, unknown> = {}) {
  const set = new Set(emails.map(e => e.toLowerCase()));
  if (set.size === 0) return;
  const message = `data: ${JSON.stringify({ type: eventType, ...data })}\n\n`;
  for (const [id, client] of clients) {
    if (!set.has(client.user.email.toLowerCase())) continue;
    try { client.res.write(message); } catch (_e) { clients.delete(id); }
  }
}

export default router;
