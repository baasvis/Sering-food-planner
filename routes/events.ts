// ─────────────────────────────────────────────────────────────────────────────
// SERVER-SENT EVENTS — Real-time sync between clients
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';

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

  // Keep-alive every 30s to prevent proxy/load-balancer timeouts
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
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
export function broadcast(senderEmail: string, eventType: string, data: Record<string, any>) {
  const payload = JSON.stringify({ type: eventType, ...data });
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

export default router;
