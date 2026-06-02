// ─────────────────────────────────────────────────────────────────────────────
// RECIPE AI — director-only chat endpoint for the private AI recipe assistant
//
// POST /api/recipe-ai/chat — SSE stream. Forwards the user's chat message and
// the current editor recipe state to lib/recipe-ai.ts, which runs a Claude
// tool-use loop and emits text deltas + state updates as the model writes.
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { asyncHandler, safeErrMsg } from '../lib/config';
import { requireDirector } from './auth';
import { loadIngredients } from './ingredients';
import { addBackendEvent } from './telemetry';
import { chatStream, loadExemplars } from '../lib/recipe-ai';
import type { AIChatMessage, AIRecipeState, ChatStreamEvent } from '../lib/recipe-ai';

const router = express.Router();

router.post('/chat', requireDirector, asyncHandler(async (req: Request, res: Response) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'AI assistant not configured', message: 'ANTHROPIC_API_KEY is not set on the server.' });
    return;
  }

  const body = req.body as { messages?: unknown; recipeState?: unknown };
  if (!Array.isArray(body.messages) || !body.recipeState || typeof body.recipeState !== 'object') {
    res.status(400).json({ error: 'messages[] and recipeState required' });
    return;
  }

  // Validate the message shape lightly — the heavy lifting happens server-side
  // when we feed them to the SDK.
  const messages: AIChatMessage[] = body.messages.map(raw => {
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

  // Set up SSE. Once these headers are sent, all errors must be reported via
  // an `error` event rather than an HTTP status code.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function send(event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Heartbeat keeps proxies from closing the connection on long Claude turns.
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);

  // Cancel the upstream Anthropic request if the SSE client disconnects (tab
  // close, navigation, network drop). Without this the chat loop would keep
  // streaming tokens to a dead socket — burning API budget for nothing and
  // pinning a request slot.
  const ctrl = new AbortController();
  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
    ctrl.abort();
    clearInterval(heartbeat);
  });

  const recipeState = body.recipeState as AIRecipeState;

  try {
    const [ingredients, exemplars] = await Promise.all([
      loadIngredients(),
      loadExemplars(),
    ]);

    const result = await chatStream(
      messages, recipeState, ingredients, exemplars,
      (e: ChatStreamEvent) => { send(e.type, e); },
      ctrl.signal,
    );

    if (clientClosed) return; // Nothing to write to; suppress final events.

    send('done', {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cacheReadTokens: result.cacheReadTokens,
    });
    addBackendEvent('feature_use', 'ai_recipe_chat_message', {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cacheReadTokens: result.cacheReadTokens,
    });
  } catch (e: unknown) {
    // If the abort was self-triggered by the client closing, the SDK throws
    // APIUserAbortError. Don't bother emitting telemetry or trying to write
    // to the closed socket — the disconnect is the user's choice, not a bug.
    if (clientClosed) return;
    const msg = safeErrMsg(e);
    addBackendEvent('error', 'ai_recipe_chat_error', { error: msg });
    send('error', { message: msg });
  } finally {
    clearInterval(heartbeat);
    if (!clientClosed) res.end();
  }
}));

export default router;
