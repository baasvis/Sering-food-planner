// ─────────────────────────────────────────────────────────────────────────────
// FEEDBACK AI CHAT — staff-facing intake assistant (the default feedback flow)
//
// A short, non-technical chat that helps a cook or floor-staff member describe
// an issue or idea. Talks to /api/feedback-ai/chat over SSE. When the assistant
// understands enough it emits a `proposal` event — an editable "here's what I'll
// send Daan" card. The person tweaks it and taps Send, which POSTs a structured
// report to /api/feedback (source='assistant'). A "quick note" link in the
// header drops to the legacy one-shot form.
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { apiPost, toast, toastError } from './utils';
import { showModal, closeModal, esc } from './modal';
import { trackEvent } from './telemetry';

interface FeedbackReport {
  title: string;
  category: 'idea' | 'issue' | 'confusing' | 'nice' | 'general';
  summary: string;
  doing: string;
  expected: string;
  severity: '' | 'low' | 'medium' | 'high';
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const CATEGORY_META: Record<string, { icon: string; label: string }> = {
  idea: { icon: '&#128161;', label: 'New idea' },
  issue: { icon: '&#128027;', label: 'Something broke' },
  confusing: { icon: '&#128566;', label: 'Confusing' },
  nice: { icon: '&#128077;', label: 'Something nice' },
  general: { icon: '&#128172;', label: 'General' },
};

const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '— not a problem —' },
  { value: 'low', label: 'Minor annoyance' },
  { value: 'medium', label: 'Slows me down' },
  { value: 'high', label: 'Blocks me / lost work' },
];

let messages: ChatMessage[] = [];
let status: 'idle' | 'streaming' | 'error' = 'idle';
let proposal: FeedbackReport | null = null;
let currentScreen = '';
let abortCtrl: AbortController | null = null;

// ── Entry point (FAB → window.openFeedback) ──

export function openFeedbackChat(): void {
  trackEvent('feedback_chat_open');
  currentScreen = document.querySelector('.screen.active')?.id?.replace('screen-', '') || 'unknown';
  messages = [];
  status = 'idle';
  proposal = null;
  if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }

  showModal(`
    <div class="fb-chat">
      <div class="ai-chat-header">
        <span class="ai-chat-title">&#128172; Tell us what's up</span>
        <button class="fb-chat-quick" onclick="openQuickFeedback()" title="Skip the chat and just type a note">Quick note &rarr;</button>
      </div>
      <div class="ai-chat-messages" id="fb-chat-messages">${renderMessages()}</div>
      <div id="fb-proposal"></div>
      <div class="ai-chat-input-row">
        <textarea class="ai-chat-input" id="fb-chat-input"
          aria-label="Describe your issue or idea"
          placeholder="In your own words&hellip; (Ctrl/Cmd+Enter to send)"
          onkeydown="feedbackChatKey(event)"></textarea>
        <button class="ai-chat-send" id="fb-chat-send" onclick="feedbackChatSend()">Send</button>
      </div>
    </div>`);

  const input = document.getElementById('fb-chat-input') as HTMLTextAreaElement | null;
  if (input) input.focus();
}

function renderMessages(): string {
  if (messages.length === 0) {
    return `<div class="ai-chat-empty">
      <p>Hi! What's on your mind?</p>
      <p class="ai-chat-empty-hint">Tell me what happened, what was confusing, or an idea &mdash; in your own words. I'll turn it into a clear note for Daan.</p>
    </div>`;
  }
  return messages.map((m, idx) => renderMessage(m, idx)).join('');
}

function renderMessage(m: ChatMessage, idx: number): string {
  const cls = m.role === 'user' ? 'ai-chat-msg-user' : 'ai-chat-msg-assistant';
  const text = m.content
    ? `<div class="ai-chat-msg-text">${esc(m.content)}</div>`
    : (m.role === 'assistant' && status === 'streaming' && idx === messages.length - 1
        ? '<div class="ai-chat-msg-text ai-chat-typing"><span></span><span></span><span></span></div>'
        : '');
  return `<div class="ai-chat-msg ${cls}" data-idx="${idx}">${text}</div>`;
}

function refreshMessages(): void {
  const el = document.getElementById('fb-chat-messages');
  if (!el) return;
  el.innerHTML = renderMessages();
  el.scrollTop = el.scrollHeight;
}

function refreshControls(): void {
  const input = document.getElementById('fb-chat-input') as HTMLTextAreaElement | null;
  const button = document.getElementById('fb-chat-send') as HTMLButtonElement | null;
  const isStreaming = status === 'streaming';
  if (input) input.disabled = isStreaming;
  if (button) {
    button.disabled = isStreaming;
    button.textContent = isStreaming ? '…' : 'Send';
  }
}

/** Append streaming assistant text in place (no full re-render). */
function appendAssistantText(delta: string): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  last.content += delta;
  const el = document.getElementById('fb-chat-messages');
  if (!el) return;
  const lastBubble = el.lastElementChild;
  if (!lastBubble) return;
  let textEl = lastBubble.querySelector('.ai-chat-msg-text') as HTMLElement | null;
  if (!textEl || textEl.classList.contains('ai-chat-typing')) {
    if (textEl) textEl.remove();
    textEl = document.createElement('div');
    textEl.className = 'ai-chat-msg-text';
    lastBubble.insertBefore(textEl, lastBubble.firstChild);
  }
  textEl.textContent = last.content;
  el.scrollTop = el.scrollHeight;
}

// ── Proposal card (separate container so message re-renders never wipe edits) ──

function renderProposalCard(): void {
  const host = document.getElementById('fb-proposal');
  if (!host || !proposal) return;
  const p = proposal;
  const catOptions = Object.entries(CATEGORY_META).map(([key, meta]) =>
    `<option value="${key}"${key === p.category ? ' selected' : ''}>${meta.label}</option>`,
  ).join('');
  const sevOptions = SEVERITY_OPTIONS.map(o =>
    `<option value="${o.value}"${o.value === p.severity ? ' selected' : ''}>${esc(o.label)}</option>`,
  ).join('');
  const context = [p.doing ? `<div class="fb-prop-ctx"><strong>What you were doing:</strong> ${esc(p.doing)}</div>` : '',
                   p.expected ? `<div class="fb-prop-ctx"><strong>Expected vs happened:</strong> ${esc(p.expected)}</div>` : ''].join('');

  host.innerHTML = `
    <div class="fb-proposal">
      <div class="fb-prop-head">&#10004; Here's what I'll send Daan &mdash; tweak anything, then send</div>
      <label class="fb-prop-label">Headline</label>
      <input class="fb-prop-input" id="fb-prop-title" value="${esc(p.title)}" />
      <div class="fb-prop-row">
        <div class="fb-prop-col">
          <label class="fb-prop-label">Kind</label>
          <select class="fb-prop-select" id="fb-prop-category">${catOptions}</select>
        </div>
        <div class="fb-prop-col">
          <label class="fb-prop-label">How urgent?</label>
          <select class="fb-prop-select" id="fb-prop-severity">${sevOptions}</select>
        </div>
      </div>
      <label class="fb-prop-label">The message</label>
      <textarea class="fb-prop-textarea" id="fb-prop-summary">${esc(p.summary)}</textarea>
      ${context}
      <div class="fb-prop-actions">
        <span class="fb-prop-hint">Not right? Just keep chatting below.</span>
        <button class="btn btn-purple" data-testid="feedback-send-report" onclick="sendFeedbackReport()">Send to Daan</button>
      </div>
    </div>`;
  const el = document.getElementById('fb-chat-messages');
  if (el) el.scrollTop = el.scrollHeight;
}

// ── Send a chat message ──

async function sendMessage(text: string): Promise<void> {
  if (status === 'streaming' || !text.trim()) return;
  trackEvent('feedback_chat_message_sent');

  messages.push({ role: 'user', content: text });
  messages.push({ role: 'assistant', content: '' });
  status = 'streaming';
  refreshMessages();
  refreshControls();

  abortCtrl = new AbortController();

  try {
    const res = await fetch('/api/feedback-ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.slice(0, -1), screen: currentScreen }),
      signal: abortCtrl.signal,
    });
    if (!res.ok) {
      let errText: string;
      try { const j = await res.json(); errText = j.error || j.message || `HTTP ${res.status}`; }
      catch { errText = `HTTP ${res.status}`; }
      throw new Error(errText);
    }
    if (!res.body) throw new Error('No response body');

    await consumeSSE(res.body);
    status = 'idle';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (!(e instanceof Error && e.name === 'AbortError')) {
      messages.push({ role: 'assistant', content: `⚠️ ${msg}` });
      trackEvent('feedback_chat_error', '', { error: msg });
    }
    status = 'error';
  } finally {
    abortCtrl = null;
    refreshMessages();
    refreshControls();
  }
}

async function consumeSSE(stream: ReadableStream<Uint8Array>): Promise<void> {
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
        if (line.startsWith(':')) continue; // heartbeat
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;

      let parsed: { text?: string; report?: FeedbackReport; message?: string };
      try { parsed = JSON.parse(data); } catch { continue; }

      switch (event) {
        case 'text':
          if (typeof parsed.text === 'string') appendAssistantText(parsed.text);
          break;
        case 'proposal':
          if (parsed.report) { proposal = parsed.report; renderProposalCard(); }
          break;
        case 'done':
          break;
        case 'error':
          throw new Error(parsed.message || 'AI error');
      }
    }
  }
}

// ── Send the confirmed report to the director ──

export async function sendFeedbackReport(): Promise<void> {
  if (!proposal) return;
  const title = (document.getElementById('fb-prop-title') as HTMLInputElement | null)?.value?.trim() || proposal.title;
  const category = (document.getElementById('fb-prop-category') as HTMLSelectElement | null)?.value || proposal.category;
  const severity = (document.getElementById('fb-prop-severity') as HTMLSelectElement | null)?.value || '';
  const summary = (document.getElementById('fb-prop-summary') as HTMLTextAreaElement | null)?.value?.trim() || proposal.summary;

  if (!summary) { toastError('The message is empty — add a line before sending'); return; }

  trackEvent('feedback_chat_report_sent', '', { category });

  const payload = {
    type: category,
    title,
    text: summary,
    severity,
    source: 'assistant',
    screen: currentScreen,
    details: {
      doing: proposal.doing,
      expected: proposal.expected,
      transcript: messages.filter(m => m.content),
    },
    user: S.user?.name || S.user?.email || 'anonymous',
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };

  try {
    await apiPost('/api/feedback', payload);
    closeModal();
    toast('Thanks — sent to Daan!');
  } catch (e: unknown) {
    toastError('Could not send: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Window-bound handlers (inline onclick/onkeydown) ──

export function feedbackChatSend(): void {
  const input = document.getElementById('fb-chat-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const text = input.value;
  input.value = '';
  void sendMessage(text);
}

export function feedbackChatKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    feedbackChatSend();
  }
}
