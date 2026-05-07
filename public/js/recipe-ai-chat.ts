// ─────────────────────────────────────────────────────────────────────────────
// AI RECIPE CHAT — director-only chat panel inside the recipe editor
//
// Talks to /api/recipe-ai/chat over SSE. Each user message ships the current
// editor state; tool calls in the response stream back as state_update events
// which we apply via the editor's setState hook so the form updates live.
// ─────────────────────────────────────────────────────────────────────────────

import { esc } from './modal';
import { trackEvent } from './telemetry';

// Minimal shape of the recipe state we exchange with the server. Mirrors the
// AIRecipeState in lib/recipe-ai.ts. Frontend code converts to/from the
// editor's richer EditorState in recipe-editor.ts.
export interface AIRecipeStateClient {
  name: string;
  type: string;
  structure: string;
  seasonality: string;
  servingTemp: string;
  servingSize: number;
  ingredients: Array<{
    ingredientId: string | null;
    ingredientName: string;
    rawAmount: number;
    unit: string;
    isFlexible: boolean;
    flexCategory: string | null;
    flexLabel: string | null;
  }>;
  prepSteps: Array<{ text: string; note?: string }>;
  coolingMethod: string;
  storageMethod: string;
  extraAllergens: string[];
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolUses?: { name: string; summary: string }[];
}

interface ChatHooks {
  getState: () => AIRecipeStateClient;
  setState: (s: AIRecipeStateClient) => void;
}

let messages: ChatMessage[] = [];
let status: 'idle' | 'streaming' | 'error' = 'idle';
let hooks: ChatHooks | null = null;
let abortCtrl: AbortController | null = null;

/** Reset the conversation. Call when the editor modal opens fresh. */
export function resetChat(): void {
  messages = [];
  status = 'idle';
  if (abortCtrl) {
    abortCtrl.abort();
    abortCtrl = null;
  }
}

/** Render the chat panel into the given container. Idempotent — safe to
 *  call again on toggle/reflow. */
export function renderChatPanel(container: HTMLElement, h: ChatHooks): void {
  hooks = h;
  container.innerHTML = renderHTML();
}

function renderHTML(): string {
  const isStreaming = status === 'streaming';
  return `
    <div class="ai-chat-header">
      <span class="ai-chat-title">✨ AI helper</span>
      <button class="ai-chat-clear" onclick="aiRecipeReset()" title="Start a fresh conversation">↺</button>
    </div>
    <div class="ai-chat-messages" id="ai-chat-messages">
      ${renderMessages()}
    </div>
    <div class="ai-chat-input-row">
      <textarea class="ai-chat-input" id="ai-chat-input"
        placeholder="Describe a recipe… (Ctrl/Cmd+Enter to send)"
        ${isStreaming ? 'disabled' : ''}
        onkeydown="aiRecipeKey(event)"></textarea>
      <button class="ai-chat-send" id="ai-chat-send" onclick="aiRecipeSend()" ${isStreaming ? 'disabled' : ''}>
        ${isStreaming ? '…' : 'Send'}
      </button>
    </div>
  `;
}

function renderMessages(): string {
  if (messages.length === 0) {
    return `<div class="ai-chat-empty">
      <p>Hi! Tell me what kind of recipe you'd like to draft.</p>
      <p class="ai-chat-empty-hint">Try: <em>"Make a winter soup with red lentils"</em> or <em>"A Persian-inspired main course for 60"</em>.</p>
    </div>`;
  }
  return messages.map((m, idx) => renderMessage(m, idx)).join('');
}

function renderMessage(m: ChatMessage, idx: number): string {
  const cls = m.role === 'user' ? 'ai-chat-msg-user' : 'ai-chat-msg-assistant';
  const tools = (m.toolUses || []).map(t =>
    `<span class="ai-chat-tool-chip" title="${esc(t.name)}">✓ ${esc(t.summary)}</span>`,
  ).join('');
  const text = m.content
    ? `<div class="ai-chat-msg-text">${esc(m.content)}</div>`
    : (m.role === 'assistant' && status === 'streaming' && idx === messages.length - 1
        ? '<div class="ai-chat-msg-text ai-chat-typing"><span></span><span></span><span></span></div>'
        : '');
  return `<div class="ai-chat-msg ${cls}" data-idx="${idx}">
    ${text}
    ${tools}
  </div>`;
}

function refreshMessages(): void {
  const el = document.getElementById('ai-chat-messages');
  if (!el) return;
  el.innerHTML = renderMessages();
  el.scrollTop = el.scrollHeight;
}

function refreshControls(): void {
  const input = document.getElementById('ai-chat-input') as HTMLTextAreaElement | null;
  const button = document.getElementById('ai-chat-send') as HTMLButtonElement | null;
  const isStreaming = status === 'streaming';
  if (input) input.disabled = isStreaming;
  if (button) {
    button.disabled = isStreaming;
    button.textContent = isStreaming ? '…' : 'Send';
  }
}

/** Update the streaming assistant message text in place — avoids re-renders. */
function appendAssistantText(delta: string): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  last.content += delta;
  const el = document.getElementById('ai-chat-messages');
  if (!el) return;
  const lastBubble = el.lastElementChild;
  if (!lastBubble) return;
  let textEl = lastBubble.querySelector('.ai-chat-msg-text') as HTMLElement | null;
  if (!textEl || textEl.classList.contains('ai-chat-typing')) {
    // Replace the typing indicator with a text node
    if (textEl) textEl.remove();
    textEl = document.createElement('div');
    textEl.className = 'ai-chat-msg-text';
    lastBubble.insertBefore(textEl, lastBubble.firstChild);
  }
  textEl.textContent = last.content;
  el.scrollTop = el.scrollHeight;
}

function appendToolChip(name: string, summary: string): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  if (!last.toolUses) last.toolUses = [];
  last.toolUses.push({ name, summary });
  refreshMessages();
}

async function sendMessage(text: string): Promise<void> {
  if (status === 'streaming' || !text.trim() || !hooks) return;

  trackEvent('ai_recipe_chat_message_sent');

  messages.push({ role: 'user', content: text });
  messages.push({ role: 'assistant', content: '' });
  status = 'streaming';
  refreshMessages();
  refreshControls();

  const recipeState = hooks.getState();
  abortCtrl = new AbortController();

  try {
    const res = await fetch('/api/recipe-ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Send everything except the empty placeholder we just pushed
        messages: messages.slice(0, -1),
        recipeState,
      }),
      signal: abortCtrl.signal,
    });
    if (!res.ok) {
      let errText: string;
      try {
        const j = await res.json();
        errText = j.error || j.message || `HTTP ${res.status}`;
      } catch {
        errText = `HTTP ${res.status}`;
      }
      throw new Error(errText);
    }
    if (!res.body) throw new Error('No response body');

    await consumeSSE(res.body, hooks);
    status = 'idle';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg !== 'AbortError' && !(e instanceof Error && e.name === 'AbortError')) {
      messages.push({ role: 'assistant', content: `⚠️ ${msg}` });
      trackEvent('ai_recipe_chat_error', { error: msg });
    }
    status = 'error';
  } finally {
    abortCtrl = null;
    refreshMessages();
    refreshControls();
  }
}

async function consumeSSE(stream: ReadableStream<Uint8Array>, h: ChatHooks): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue; // heartbeat / comment
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;

      let parsed: { text?: string; name?: string; summary?: string; state?: AIRecipeStateClient; message?: string };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      switch (event) {
        case 'text':
          if (typeof parsed.text === 'string') appendAssistantText(parsed.text);
          break;
        case 'tool_use':
          if (parsed.name && parsed.summary) appendToolChip(parsed.name, parsed.summary);
          break;
        case 'state_update':
          if (parsed.state) h.setState(parsed.state);
          break;
        case 'done':
          // tokens info ignored in v1
          break;
        case 'error':
          throw new Error(parsed.message || 'AI error');
      }
    }
  }
}

// ── Window-bound handlers (called from inline onclick="" attrs) ──

export function aiRecipeSend(): void {
  const input = document.getElementById('ai-chat-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const text = input.value;
  input.value = '';
  void sendMessage(text);
}

export function aiRecipeKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    aiRecipeSend();
  }
}

export function aiRecipeReset(): void {
  resetChat();
  refreshMessages();
  refreshControls();
}
