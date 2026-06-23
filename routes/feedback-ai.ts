// ─────────────────────────────────────────────────────────────────────────────
// FEEDBACK AI — staff-facing intake chat endpoint
//
// POST /api/feedback-ai/chat — SSE stream. Open to any signed-in user (mounted
// under the global requireAuth in app.ts, NOT director-gated like recipe-ai).
// Forwards the conversation + current screen to lib/feedback-ai.ts, which runs a
// Claude tool-use loop and streams text deltas plus `proposal` events (the
// editable report card the person reviews before sending).
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { asyncHandler, safeErrMsg } from '../lib/config';
import { addBackendEvent } from './telemetry';
import { feedbackChatStream, loadRecentActivity } from '../lib/feedback-ai';
import type { FeedbackChatMessage, FeedbackChatEvent } from '../lib/feedback-ai';

const router = express.Router();

router.post('/chat', asyncHandler(async (req: Request, res: Response) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'AI assistant not configured', message: 'ANTHROPIC_API_KEY is not set on the server.' });
    return;
  }

  const body = req.body as { messages?: unknown; screen?: unknown };
  if (!Array.isArray(body.messages)) {
    res.status(400).json({ error: 'messages[] required' });
    return;
  }

  const messages: FeedbackChatMessage[] = body.messages.map(raw => {
    const m = raw as { role?: unknown; content?: unknown };
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw new Error('Invalid message shape');
    }
    return { role: m.role, content: m.content };
  });
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    res.status(400).json({ error: 'Conversation must end with a user message' });
    return;
  }
  const screen = typeof body.screen === 'string' ? body.screen.slice(0, 60) : '';

  // SSE setup — once headers are sent, errors must surface as an `error` event.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function send(event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);

  const ctrl = new AbortController();
  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
    ctrl.abort();
    clearInterval(heartbeat);
  });

  try {
    const activity = await loadRecentActivity(req.user?.email, screen);

    const result = await feedbackChatStream(
      messages, activity,
      (e: FeedbackChatEvent) => { send(e.type, e); },
      ctrl.signal,
    );

    if (clientClosed) return;

    send('done', {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cacheReadTokens: result.cacheReadTokens,
    });
    addBackendEvent('feature_use', 'feedback_ai_chat_message', {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cacheReadTokens: result.cacheReadTokens,
      proposed: result.proposal != null,
    });
  } catch (e: unknown) {
    if (clientClosed) return;
    const msg = safeErrMsg(e);
    addBackendEvent('error', 'feedback_ai_chat_error', { error: msg });
    send('error', { message: msg });
  } finally {
    clearInterval(heartbeat);
    if (!clientClosed) res.end();
  }
}));

export default router;
