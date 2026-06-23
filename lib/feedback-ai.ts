// ─────────────────────────────────────────────────────────────────────────────
// FEEDBACK AI — staff-facing intake assistant for the food planner
//
// A short, non-technical clarifying chat (for cooks + floor staff) that distils
// what someone says into a structured report for the director. Mirrors the
// recipe-assistant architecture (lib/recipe-ai.ts): a cached system prompt, a
// streaming Claude tool-use loop, abort handling, and token accounting — but it
// owns no editor state. Its single tool, `propose_report`, produces the report
// card the person reviews before sending; the loop streams the assistant's text
// deltas and emits a `proposal` event whenever the tool fires.
//
// Unlike the recipe assistant this is open to ANY signed-in user, so it leans on
// a cheap-by-config model and keeps the turn budget small.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import { prisma } from './db';
import { errMsg } from './config';

// ── Wire types (shared with the frontend via JSON) ──

export type FeedbackCategory = 'idea' | 'issue' | 'confusing' | 'nice' | 'general';
export type FeedbackSeverity = '' | 'low' | 'medium' | 'high';

/** The structured report the assistant proposes and the person confirms. */
export interface FeedbackReport {
  title: string;
  category: FeedbackCategory;
  summary: string;
  /** What they were trying to do when this came up ('' = not relevant). */
  doing: string;
  /** What they expected vs what happened ('' = not relevant). */
  expected: string;
  severity: FeedbackSeverity;
}

export interface FeedbackChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type FeedbackChatEvent =
  | { type: 'text'; text: string }
  | { type: 'proposal'; report: FeedbackReport }
  | { type: 'done'; tokensIn: number; tokensOut: number; cacheReadTokens: number }
  | { type: 'error'; message: string };

const CATEGORIES: readonly FeedbackCategory[] = ['idea', 'issue', 'confusing', 'nice', 'general'];
const SEVERITIES: readonly FeedbackSeverity[] = ['', 'low', 'medium', 'high'];

// ── Report normalization (pure, unit-testable) ──

/** Coerce untrusted tool input into a valid FeedbackReport. Unknown categories
 *  fall back to 'general'; unknown severities to '' so a bad enum never blocks
 *  the proposal. */
export function normalizeReport(input: unknown): FeedbackReport {
  const i = (input ?? {}) as Partial<Record<keyof FeedbackReport, unknown>>;
  const category = typeof i.category === 'string' && (CATEGORIES as readonly string[]).includes(i.category)
    ? i.category as FeedbackCategory
    : 'general';
  const severity = typeof i.severity === 'string' && (SEVERITIES as readonly string[]).includes(i.severity)
    ? i.severity as FeedbackSeverity
    : '';
  return {
    title: typeof i.title === 'string' ? i.title.trim().slice(0, 120) : '',
    category,
    summary: typeof i.summary === 'string' ? i.summary.trim().slice(0, 2000) : '',
    doing: typeof i.doing === 'string' ? i.doing.trim().slice(0, 1000) : '',
    expected: typeof i.expected === 'string' ? i.expected.trim().slice(0, 1000) : '',
    severity,
  };
}

// ── Recent-activity context (telemetry, supporting signal only) ──

/** Minimal telemetry row shape used by summarizeActivity — decoupled from
 *  Prisma so the formatter is unit-testable without a DB. */
export interface ActivityRow {
  type: string;
  name: string;
}

/** Pure: fold recent telemetry rows + the current screen into a compact,
 *  plain-text hint for the model. Errors and screen names are passed through
 *  as-is (the prompt tells the model not to read raw error text back to the
 *  user). Always returns a non-empty string. */
export function summarizeActivity(rows: ActivityRow[], currentScreen: string): string {
  const lines: string[] = [];
  const screen = (currentScreen || '').trim();
  if (screen) lines.push(`The person is on the "${screen}" screen right now.`);

  const screensSeen: string[] = [];
  for (const r of rows) {
    if (r.type === 'screen_view' && r.name && !screensSeen.includes(r.name)) screensSeen.push(r.name);
  }
  if (screensSeen.length) {
    lines.push(`Screens they used recently: ${screensSeen.slice(0, 6).join(', ')}.`);
  }

  const errors = rows
    .filter(r => r.type === 'error' && r.name)
    .map(r => r.name)
    .slice(0, 5);
  if (errors.length) {
    lines.push('Errors the app logged for them recently (a hint — do not read these out verbatim):');
    for (const e of errors) lines.push(`- ${e}`);
  }

  return lines.length ? lines.join('\n') : 'No recent activity recorded for this person.';
}

const ACTIVITY_WINDOW_MS = 45 * 60 * 1000;
const ACTIVITY_MAX_ROWS = 40;

/** Load + summarize a person's recent telemetry. Never throws — a telemetry
 *  hiccup must not break the chat, so failures degrade to the screen-only hint. */
export async function loadRecentActivity(email: string | undefined, currentScreen: string): Promise<string> {
  if (!email) return summarizeActivity([], currentScreen);
  try {
    const rows = await prisma.telemetryEvent.findMany({
      where: {
        userId: email,
        type: { in: ['screen_view', 'error'] },
        timestamp: { gte: new Date(Date.now() - ACTIVITY_WINDOW_MS) },
      },
      orderBy: { timestamp: 'desc' },
      take: ACTIVITY_MAX_ROWS,
      select: { type: true, name: true },
    });
    return summarizeActivity(rows, currentScreen);
  } catch (e: unknown) {
    console.warn('Feedback AI: failed to load recent activity, continuing without:', errMsg(e));
    return summarizeActivity([], currentScreen);
  }
}

// ── System prompt (read once, cached) ──

let _promptCache: string | null = null;

export function loadFeedbackPrompt(): string {
  if (_promptCache !== null) return _promptCache;
  // Mirrors lib/recipe-ai.ts: tsc leaves the .md in the source tree, so probe a
  // few paths so dev (tsx) and prod (compiled dist/) both find it.
  const candidates = [
    path.join(__dirname, 'feedback-ai-prompt.md'),
    path.join(__dirname, '..', '..', '..', 'lib', 'feedback-ai-prompt.md'),
    path.join(process.cwd(), 'lib', 'feedback-ai-prompt.md'),
  ];
  for (const p of candidates) {
    try {
      _promptCache = fs.readFileSync(p, 'utf-8');
      return _promptCache;
    } catch {
      // try next
    }
  }
  console.error('Feedback AI: could not locate feedback-ai-prompt.md in any of:', candidates);
  _promptCache = '# Sering feedback assistant\n\nHelp staff describe an issue or idea, then summarise it for the director.\n';
  return _promptCache;
}

interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

function buildSystemPrompt(): SystemBlock[] {
  return [{ type: 'text', text: loadFeedbackPrompt(), cache_control: { type: 'ephemeral' } }];
}

// ── Tool schema ──

export const FEEDBACK_TOOLS = [
  {
    name: 'propose_report',
    description:
      "Call this once you understand the person's issue or idea well enough that the director would understand it without reading the chat. It shows the person an editable card they review and send. Call it again with corrected fields if they fix something. Keep asking questions instead only when the issue is still genuinely unclear.",
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short headline (a handful of words), in English — the label the director scans in a list.' },
        category: { type: 'string', enum: CATEGORIES, description: 'issue = something broke; confusing = worked but unclear; idea = request/improvement; nice = praise; general = none of these.' },
        summary: { type: 'string', description: '2-4 plain-language sentences, in the language the person used, that let the director understand the situation on its own.' },
        doing: { type: 'string', description: 'What the person was trying to get done when this came up. Empty string if not relevant.' },
        expected: { type: 'string', description: 'For problems/confusion: what they expected vs what actually happened. Empty string if not relevant.' },
        severity: { type: 'string', enum: SEVERITIES, description: 'Only for problems: low = minor annoyance, medium = slows work down, high = blocks them or loses work. Empty for ideas/praise.' },
      },
      required: ['title', 'category', 'summary'],
    },
  },
];

// ── Streaming chat loop ──

const MODEL = process.env.FEEDBACK_AI_MODEL || 'claude-opus-4-8';
const MAX_TOOL_LOOPS = 6;
// Deliberately small — turns are a short clarifying line or one propose_report
// tool call. 2048 leaves headroom so a fully-filled report JSON never truncates.
const MAX_TOKENS_PER_TURN = 2048;

export interface FeedbackChatResult {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  proposal: FeedbackReport | null;
}

/** Run the intake chat loop, streaming text and emitting a `proposal` event
 *  whenever the model calls `propose_report`. Resolves when Claude returns a
 *  non-tool stop_reason.
 *
 *  `signal` cancels the upstream Anthropic call when the SSE client disconnects
 *  — see routes/feedback-ai.ts. */
export async function feedbackChatStream(
  messages: FeedbackChatMessage[],
  activityContext: string,
  onEvent: (e: FeedbackChatEvent) => void,
  signal?: AbortSignal,
): Promise<FeedbackChatResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
  const client = new AnthropicSDK({ apiKey });
  const system = buildSystemPrompt();

  // Seed the conversation; the recent-activity hint rides on the LATEST user
  // message as a preamble (older turns don't get re-stamped — the model can
  // scroll back). Mirrors the editor_state preamble in lib/recipe-ai.ts.
  const conversation: Anthropic.MessageParam[] = [];
  for (let idx = 0; idx < messages.length; idx++) {
    const m = messages[idx];
    if (m.role === 'user' && idx === messages.length - 1) {
      conversation.push({
        role: 'user',
        content: `<recent_activity>\n${activityContext}\n</recent_activity>\n\n${m.content}`,
      });
    } else {
      conversation.push({ role: m.role, content: m.content });
    }
  }

  let proposal: FeedbackReport | null = null;
  let totalIn = 0, totalOut = 0, totalCache = 0;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    if (signal?.aborted) {
      return { tokensIn: totalIn, tokensOut: totalOut, cacheReadTokens: totalCache, proposal };
    }

    // tool_use_id → whether this id was a propose_report we surfaced, so the
    // tool_result we hand back is honest about what happened.
    const proposed = new Set<string>();

    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS_PER_TURN,
        system,
        messages: conversation,
        tools: FEEDBACK_TOOLS,
      },
      signal ? { signal } : undefined,
    );

    stream.on('text', (textDelta: string) => {
      onEvent({ type: 'text', text: textDelta });
    });

    stream.on('contentBlock', (block: Anthropic.ContentBlock) => {
      if (block.type !== 'tool_use' || block.name !== 'propose_report') return;
      const report = normalizeReport(block.input);
      proposal = report;
      proposed.add(block.id);
      onEvent({ type: 'proposal', report });
    });

    const finalMessage = await stream.finalMessage();

    totalIn += finalMessage.usage.input_tokens || 0;
    totalOut += finalMessage.usage.output_tokens || 0;
    totalCache += finalMessage.usage.cache_read_input_tokens || 0;

    if (finalMessage.stop_reason !== 'tool_use') {
      return { tokensIn: totalIn, tokensOut: totalOut, cacheReadTokens: totalCache, proposal };
    }

    if (signal?.aborted) {
      return { tokensIn: totalIn, tokensOut: totalOut, cacheReadTokens: totalCache, proposal };
    }

    // Hand back tool_results so the model can add its short closing line.
    conversation.push({ role: 'assistant', content: finalMessage.content });
    const toolUseBlocks = finalMessage.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const toolResults = toolUseBlocks.map(b => ({
      type: 'tool_result' as const,
      tool_use_id: b.id,
      content: proposed.has(b.id)
        ? 'The report card is now shown to the person for review. Add one short, friendly line telling them they can edit anything and tap Send when it looks right. Do not repeat the summary.'
        : 'Unknown tool.',
    }));
    conversation.push({ role: 'user', content: toolResults });
  }

  onEvent({ type: 'error', message: 'Reached maximum tool-use iterations.' });
  return { tokensIn: totalIn, tokensOut: totalOut, cacheReadTokens: totalCache, proposal };
}
