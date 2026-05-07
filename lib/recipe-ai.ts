// ─────────────────────────────────────────────────────────────────────────────
// AI RECIPE ASSISTANT — director-only Claude tool-use chat for drafting recipes
//
// Three responsibilities:
//   1. Build the cached system prompt (house-style doc + ingredient catalog +
//      3 exemplar recipes) so the AI knows what a Sering recipe looks like.
//   2. Define the tools Claude can call to mutate an in-flight recipe state.
//   3. Stream a tool-use chat loop, applying tool calls to the state and
//      forwarding events to the SSE handler in routes/recipe-ai.ts.
//
// The state lives on the wire — there is no server-side persistence. Each
// chat turn POSTs the full state + conversation; this module returns the
// updated state and forwards the assistant's text deltas. The frontend
// merges the returned state back into the recipe editor.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import { prisma } from './db';
import { errMsg } from './config';
import type { Ingredient, RecipeFull } from '../shared/types';

// ── Wire types (shared with frontend via JSON, no Prisma coupling) ──

export interface AIIngredientRow {
  ingredientId: string | null;
  ingredientName: string;
  /** What the cook starts with — unpeeled / unwashed / raw weight. */
  rawAmount: number;
  /** What's left in the finished dish after cleaning, peeling, frying,
   *  evaporation. Same unit as rawAmount. The editor uses the sum of
   *  cookedAmount values (falling back to rawAmount when null) to compute
   *  total recipe volume → portion count. Null means "not estimated" and
   *  is a soft failure — the AI should fill it in for every ingredient. */
  cookedAmount: number | null;
  unit: string;
  isFlexible: boolean;
  flexCategory: string | null;
  flexLabel: string | null;
}

export interface AIPrepStep {
  text: string;
  note?: string;
}

export interface AIRecipeState {
  name: string;
  type: string;
  structure: string;
  seasonality: string;
  servingTemp: string;
  servingSize: number;
  ingredients: AIIngredientRow[];
  prepSteps: AIPrepStep[];
  coolingMethod: string;
  storageMethod: string;
  extraAllergens: string[];
}

export interface AIChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; summary: string }
  | { type: 'state_update'; state: AIRecipeState }
  | { type: 'done'; tokensIn: number; tokensOut: number; cacheReadTokens: number }
  | { type: 'error'; message: string };

// ── Exemplar recipes — hand-picked from the prod library ──
//
// One Soup, one Main course, one Dessert that show the house style at its
// best. Loaded once per process and re-used across chat sessions.

export const EXEMPLAR_IDS = [
  'e3365e92-94ed-4749-b9da-35cc83211595', // Cajun-style red lentil soup (open structure)
  'c547de85-3e3c-4650-a0d4-cc56b1483cd0', // Carrot Coconut Dahl (closed + LARGE SCALE STYLE)
  '202eb783-49da-48ad-b5ea-c71468dfe43d', // Johannas Banana Cinnamon Crumble Cake
] as const;

let _exemplarCache: RecipeFull[] | null = null;

export async function loadExemplars(): Promise<RecipeFull[]> {
  if (_exemplarCache) return _exemplarCache;
  try {
    const rows = await prisma.recipe.findMany({
      where: { id: { in: [...EXEMPLAR_IDS] } },
      include: {
        ingredients: { include: { ingredient: { select: { name: true } } }, orderBy: { sortOrder: 'asc' } },
      },
    });
    _exemplarCache = rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      structure: r.structure,
      seasonality: r.seasonality,
      servingTemp: r.servingTemp,
      servingSize: r.servingSize,
      recipeVolume: r.recipeVolume ? Number(r.recipeVolume) : null,
      autoAllergens: Array.isArray(r.autoAllergens) ? r.autoAllergens as string[] : [],
      extraAllergens: Array.isArray(r.extraAllergens) ? r.extraAllergens as string[] : [],
      costPerServing: r.costPerServing ? Number(r.costPerServing) : null,
      avgSkill: 0, avgSpeed: 0, avgBanger: 0, timesServed: 0,
      prepSteps: (r.prepSteps as unknown as { step: number; text: string; note?: string }[]) || [],
      coolingMethod: r.coolingMethod,
      storageMethod: r.storageMethod,
      photoUrl: null,
      isComplete: r.isComplete,
      versions: [],
      createdBy: '', createdAt: '', updatedAt: '',
      legacySheetId: null,
      ingredients: r.ingredients.map(rir => ({
        id: rir.id,
        ingredientId: rir.ingredientId,
        sortOrder: rir.sortOrder,
        rawAmount: Number(rir.rawAmount),
        cookedAmount: rir.cookedAmount ? Number(rir.cookedAmount) : null,
        unit: rir.unit,
        isFlexible: rir.isFlexible,
        flexCategory: rir.flexCategory,
        flexLabel: rir.flexLabel,
        suggestedNames: Array.isArray(rir.suggestedNames) ? rir.suggestedNames as string[] : [],
        ingredientName: rir.ingredient?.name || '',
      })),
    }));
    return _exemplarCache;
  } catch (e: unknown) {
    console.warn('Recipe AI: failed to load exemplars, continuing without:', errMsg(e));
    _exemplarCache = [];
    return _exemplarCache;
  }
}

// ── House-style doc — read once at module load ──

let _houseStyleCache: string | null = null;

export function loadHouseStyle(): string {
  if (_houseStyleCache !== null) return _houseStyleCache;
  // tsc only emits .ts → .js to dist/server/, leaving the markdown behind in
  // the source tree. Try a few candidate paths so dev (tsx) and prod (compiled)
  // both find it without a separate copy step.
  const candidates = [
    path.join(__dirname, 'recipe-ai-prompt.md'),                                  // dev: lib/
    path.join(__dirname, '..', '..', '..', 'lib', 'recipe-ai-prompt.md'),         // prod: dist/server/lib/ → project/lib/
    path.join(process.cwd(), 'lib', 'recipe-ai-prompt.md'),                       // fallback
  ];
  for (const p of candidates) {
    try {
      _houseStyleCache = fs.readFileSync(p, 'utf-8');
      return _houseStyleCache;
    } catch {
      // try next
    }
  }
  console.error('Recipe AI: could not locate recipe-ai-prompt.md in any of:', candidates);
  _houseStyleCache = '# Sering recipe assistant\n\n(Style guide unavailable.)\n';
  return _houseStyleCache;
}

// ── System prompt builder ──

interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** Slim ingredient shape sent to Claude — just what's needed for picking an
 *  ingredient by name and showing the price. Skipping stock for v1 since
 *  multi-location stock is more complex than the AI usually needs. */
interface CatalogIngredient {
  id: string;
  name: string;
  category: string;
  pricePer100: number;
  allergens: string;
}

function slimIngredient(ing: Ingredient): CatalogIngredient {
  return {
    id: ing.id,
    name: ing.name,
    category: ing.category || '',
    pricePer100: ing.pricePer100 || 0,
    allergens: ing.allergens || '',
  };
}

export function buildSystemPrompt(ingredients: Ingredient[], exemplars: RecipeFull[]): SystemBlock[] {
  const houseStyle = loadHouseStyle();
  const catalog = ingredients.filter(i => i.active !== false).map(slimIngredient);
  const catalogJson = JSON.stringify(catalog, null, 0);
  const exemplarJson = JSON.stringify(exemplars, null, 0);
  // Order = most-stable-first so the cache prefix survives volatility:
  //   1. House-style doc — only changes on server restart (loaded once at module load)
  //   2. Exemplar recipes — process-cached, change rarely (when a director edits one of the 3)
  //   3. Ingredient catalog — re-fetched per chat session, changes whenever an ingredient is added/edited
  // If the catalog were ahead of the exemplars, every catalog change would invalidate
  // the exemplar block too. With this order, only the catalog re-tokenizes.
  return [
    {
      type: 'text',
      text: `${houseStyle}\n\nWhen the user types, you read the editor state below in the user message and call tools to update it. Always link ingredients by ingredientId from the catalog when one matches.`,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `## Exemplar recipes (JSON)\n\nThree existing recipes that show the Sering house style. Match their structure, voice, and ingredient density.\n\n${exemplarJson}`,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `## Ingredient catalog (JSON)\n\n${catalogJson}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// ── Tool schemas ──

const UNITS = ['Grams', 'Kilos', 'Liters', 'ML'] as const;
const RECIPE_TYPES = ['Soup', 'Main course', 'Dessert'] as const;

export const RECIPE_TOOLS = [
  {
    name: 'set_recipe_basics',
    description:
      'Update basic recipe metadata. Only include fields you want to change; omitted fields keep their current value.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Recipe name (e.g. "Cajun-style red lentil soup")' },
        type: { type: 'string', enum: RECIPE_TYPES, description: 'Recipe category' },
        structure: { type: 'string', enum: ['', 'Open structure', 'Closed structure'], description: 'Whether vegetable choices are flexible (Open) or specified (Closed)' },
        seasonality: { type: 'string', enum: ['', 'Year round', 'Spring', 'Summer', 'Fall', 'Winter'] },
        servingTemp: { type: 'string', description: 'pot / Oven / Room temperature' },
        servingSize: { type: 'number', description: 'Per-portion size in ml (default 280 for soup, 250 for main, 200 for dessert)' },
      },
    },
  },
  {
    name: 'set_ingredients',
    description:
      'Replace the entire ingredients list. Provide all ingredients in the order a cook would use them. Link to catalog ingredients by ingredientId; use ingredientName + null id only when nothing in the catalog fits. Fill in cookedAmount for every ingredient — see the house style for shrinkage estimates.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ingredients: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ingredientId: { type: ['string', 'null'], description: 'Catalog ingredient id, or null for free-text' },
              ingredientName: { type: 'string', description: 'Display name (must match catalog if ingredientId is set)' },
              rawAmount: { type: 'number', description: 'Raw / starting weight — unpeeled, unwashed' },
              cookedAmount: { type: ['number', 'null'], description: 'Weight remaining in the finished dish after cleaning, peeling, frying, evaporation (or after absorbing liquid for grains/beans). Same unit as rawAmount. See the house-style shrinkage table; only use null when truly unknown.' },
              unit: { type: 'string', enum: UNITS },
              isFlexible: { type: 'boolean', description: 'True for "any vegetable" style placeholder slots' },
              flexCategory: { type: ['string', 'null'], description: 'Category for flex slots, e.g. "Vegetables & Fruit"' },
              flexLabel: { type: ['string', 'null'], description: 'Human label for flex slot, e.g. "Any vegetables"' },
            },
            required: ['ingredientName', 'rawAmount', 'unit'],
          },
        },
      },
      required: ['ingredients'],
    },
  },
  {
    name: 'set_prep_steps',
    description:
      'Replace the entire prep-steps list. Steps are numbered automatically; provide them in execution order. Follow the liquid-first principle from the house style.',
    input_schema: {
      type: 'object' as const,
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The step instruction (one action, 1-3 sentences)' },
              note: { type: 'string', description: 'Optional inline tip or warning' },
            },
            required: ['text'],
          },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'set_storage',
    description:
      'Update cooling and storage methods. Leave blank by default — the kitchen has standard protocols. Only fill when the recipe needs special handling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        coolingMethod: { type: 'string' },
        storageMethod: { type: 'string' },
      },
    },
  },
  {
    name: 'set_extra_allergens',
    description:
      'Set extra (cross-contamination) allergens. Auto-allergens come from linked ingredients automatically — only add here if the recipe could be contaminated with allergens not in any ingredient.',
    input_schema: {
      type: 'object' as const,
      properties: {
        allergens: { type: 'array', items: { type: 'string' } },
      },
      required: ['allergens'],
    },
  },
];

// ── Tool application (pure function, unit-testable) ──

interface ToolInputBasics {
  name?: string;
  type?: string;
  structure?: string;
  seasonality?: string;
  servingTemp?: string;
  servingSize?: number;
}

interface ToolInputIngredients {
  ingredients?: Array<Partial<AIIngredientRow> & { rawAmount: number; unit: string; ingredientName: string }>;
}

interface ToolInputPrepSteps {
  steps?: Array<{ text: string; note?: string }>;
}

interface ToolInputStorage {
  coolingMethod?: string;
  storageMethod?: string;
}

interface ToolInputAllergens {
  allergens?: string[];
}

/** Pure: applies a tool call to a recipe state. Validates ingredient ids
 *  against the catalog (drops invalid ones to free-text). Throws for
 *  unknown tool names so the caller surfaces the bug. */
export function applyToolCall(
  state: AIRecipeState,
  name: string,
  input: unknown,
  catalog: Ingredient[],
): AIRecipeState {
  switch (name) {
    case 'set_recipe_basics': {
      const i = (input ?? {}) as ToolInputBasics;
      return {
        ...state,
        ...(i.name !== undefined ? { name: String(i.name) } : {}),
        ...(i.type !== undefined ? { type: String(i.type) } : {}),
        ...(i.structure !== undefined ? { structure: String(i.structure) } : {}),
        ...(i.seasonality !== undefined ? { seasonality: String(i.seasonality) } : {}),
        ...(i.servingTemp !== undefined ? { servingTemp: String(i.servingTemp) } : {}),
        ...(i.servingSize !== undefined ? { servingSize: Number(i.servingSize) || state.servingSize } : {}),
      };
    }
    case 'set_ingredients': {
      const i = (input ?? {}) as ToolInputIngredients;
      const list = Array.isArray(i.ingredients) ? i.ingredients : [];
      const catalogIds = new Set(catalog.map(c => c.id));
      const ingredients: AIIngredientRow[] = list.map(row => {
        let ingredientId = row.ingredientId ?? null;
        if (ingredientId && !catalogIds.has(ingredientId)) ingredientId = null;
        // cookedAmount: accept finite numbers (including 0) from the SDK,
        // reject null/undefined/strings/NaN/Infinity. The schema declares
        // ['number', 'null'] but the SDK can occasionally surface coerced
        // values, so we re-check rather than trusting the cast.
        const ca = row.cookedAmount;
        const cookedAmount: number | null =
          typeof ca === 'number' && Number.isFinite(ca) ? ca : null;
        return {
          ingredientId,
          ingredientName: String(row.ingredientName || ''),
          rawAmount: Number(row.rawAmount) || 0,
          cookedAmount,
          unit: typeof row.unit === 'string' ? row.unit : 'Grams',
          isFlexible: !!row.isFlexible,
          flexCategory: row.flexCategory ?? null,
          flexLabel: row.flexLabel ?? null,
        };
      });
      return { ...state, ingredients };
    }
    case 'set_prep_steps': {
      const i = (input ?? {}) as ToolInputPrepSteps;
      const steps = Array.isArray(i.steps) ? i.steps : [];
      return {
        ...state,
        prepSteps: steps
          .filter(s => s && typeof s.text === 'string' && s.text.trim())
          .map(s => ({ text: s.text, ...(s.note ? { note: s.note } : {}) })),
      };
    }
    case 'set_storage': {
      const i = (input ?? {}) as ToolInputStorage;
      return {
        ...state,
        ...(i.coolingMethod !== undefined ? { coolingMethod: String(i.coolingMethod) } : {}),
        ...(i.storageMethod !== undefined ? { storageMethod: String(i.storageMethod) } : {}),
      };
    }
    case 'set_extra_allergens': {
      const i = (input ?? {}) as ToolInputAllergens;
      const arr = Array.isArray(i.allergens) ? i.allergens.map(String) : [];
      return { ...state, extraAllergens: arr };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Short human-readable summary of what a tool call did, for the chip in
 *  the chat. Pure — depends only on the input + the resulting state. */
export function summarizeTool(name: string, input: unknown, newState: AIRecipeState): string {
  switch (name) {
    case 'set_recipe_basics': {
      const i = (input ?? {}) as ToolInputBasics;
      const parts: string[] = [];
      if (i.name) parts.push(`name "${i.name}"`);
      if (i.type) parts.push(`type ${i.type}`);
      if (i.servingSize) parts.push(`${i.servingSize} ml/serving`);
      if (i.structure) parts.push(i.structure.toLowerCase());
      if (i.seasonality) parts.push(i.seasonality.toLowerCase());
      return parts.length ? `Set ${parts.join(', ')}` : 'Updated basics';
    }
    case 'set_ingredients':
      return `Updated ingredients (${newState.ingredients.length})`;
    case 'set_prep_steps':
      return `Updated prep steps (${newState.prepSteps.length})`;
    case 'set_storage':
      return 'Updated storage notes';
    case 'set_extra_allergens':
      return `Set extra allergens (${newState.extraAllergens.length})`;
    default:
      return name;
  }
}

// ── Streaming chat loop ──

const MODEL = process.env.AI_ANALYSIS_MODEL || 'claude-sonnet-4-6';
const MAX_TOOL_LOOPS = 10;
const MAX_TOKENS_PER_TURN = 4096;

/** Run a tool-use chat loop, streaming text and emitting state updates as
 *  tool calls are applied. Resolves when Claude returns end_turn (or any
 *  non-tool stop_reason).
 *
 *  Pass `signal` to cancel the upstream Anthropic call when the SSE client
 *  disconnects — without it, a tab close mid-stream still bills out the full
 *  response. The signal is forwarded to the SDK's request options so the
 *  underlying HTTP fetch is aborted; the SDK rejects with `APIUserAbortError`
 *  which the caller should detect via `signal.aborted` rather than the error
 *  type. */
export async function chatStream(
  messages: AIChatMessage[],
  initialState: AIRecipeState,
  ingredients: Ingredient[],
  exemplars: RecipeFull[],
  onEvent: (e: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<{ tokensIn: number; tokensOut: number; cacheReadTokens: number; finalState: AIRecipeState }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
  const client = new AnthropicSDK({ apiKey });
  const system = buildSystemPrompt(ingredients, exemplars);

  // Conversation includes a synthetic "current state" preamble so Claude
  // always knows what's in the form. We rebuild it on each loop iteration
  // so tool calls during this turn are reflected without needing extra
  // round-trips.
  const conversation: Anthropic.MessageParam[] = [];

  // Seed conversation with the user's history. The current editor state
  // rides on the LATEST user message as a state-preamble — older user
  // messages don't get re-stamped (Claude can scroll back).
  for (let idx = 0; idx < messages.length; idx++) {
    const m = messages[idx];
    if (m.role === 'user' && idx === messages.length - 1) {
      conversation.push({
        role: 'user',
        content: `<editor_state>\n${JSON.stringify(initialState, null, 0)}\n</editor_state>\n\n${m.content}`,
      });
    } else {
      conversation.push({ role: m.role, content: m.content });
    }
  }

  let state = initialState;
  let totalIn = 0, totalOut = 0, totalCache = 0;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    // Bail before issuing another billed request if the client already
    // disconnected during the previous tool round-trip.
    if (signal?.aborted) {
      return { tokensIn: totalIn, tokensOut: totalOut, cacheReadTokens: totalCache, finalState: state };
    }

    // Per-iteration result map: tool_use_id → { ok, message }. Populated by the
    // contentBlock listener as tool calls land, then read after finalMessage()
    // to build honest tool_result blocks. A failed apply must report is_error
    // so Claude can self-correct on the next turn instead of running with
    // stale state assumed to be applied.
    const toolOutcomes = new Map<string, { ok: boolean; message: string }>();

    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS_PER_TURN,
        system,
        messages: conversation,
        tools: RECIPE_TOOLS,
      },
      signal ? { signal } : undefined,
    );

    // Forward text deltas live
    stream.on('text', (textDelta: string) => {
      onEvent({ type: 'text', text: textDelta });
    });

    // Apply tool calls as their content blocks complete (mid-stream).
    // The SDK's `contentBlock` event fires after a block finishes with
    // the fully assembled block — for tool_use that's the parsed input.
    stream.on('contentBlock', (block: Anthropic.ContentBlock) => {
      if (block.type !== 'tool_use') return;
      try {
        state = applyToolCall(state, block.name, block.input, ingredients);
        const summary = summarizeTool(block.name, block.input, state);
        onEvent({ type: 'tool_use', id: block.id, name: block.name, summary });
        onEvent({ type: 'state_update', state });
        toolOutcomes.set(block.id, { ok: true, message: 'Applied successfully.' });
      } catch (e: unknown) {
        const msg = errMsg(e);
        console.error('Recipe AI: tool application failed:', msg);
        onEvent({ type: 'error', message: `Tool ${block.name} failed: ${msg}` });
        toolOutcomes.set(block.id, { ok: false, message: `Failed to apply: ${msg}. The editor state is unchanged for this tool call.` });
      }
    });

    const finalMessage = await stream.finalMessage();

    totalIn += finalMessage.usage.input_tokens || 0;
    totalOut += finalMessage.usage.output_tokens || 0;
    totalCache += finalMessage.usage.cache_read_input_tokens || 0;

    if (finalMessage.stop_reason !== 'tool_use') {
      // end_turn / max_tokens / stop_sequence — we're done
      return { tokensIn: totalIn, tokensOut: totalOut, cacheReadTokens: totalCache, finalState: state };
    }

    // Tool-use turn: append the assistant message verbatim, then add
    // tool_result blocks so Claude can continue its reasoning. Mark blocks
    // is_error when applyToolCall threw so Claude knows the state didn't change.
    conversation.push({ role: 'assistant', content: finalMessage.content });
    const toolResults = finalMessage.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map(b => {
        // If the contentBlock listener never recorded an outcome (shouldn't
        // happen, but be defensive), treat it as a soft failure.
        const outcome = toolOutcomes.get(b.id) ?? { ok: false, message: 'Tool result not captured.' };
        return {
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: outcome.message,
          ...(outcome.ok ? {} : { is_error: true as const }),
        };
      });
    conversation.push({ role: 'user', content: toolResults });
  }

  // Hit MAX_TOOL_LOOPS — bail out
  onEvent({ type: 'error', message: 'Reached maximum tool-use iterations.' });
  return { tokensIn: totalIn, tokensOut: totalOut, cacheReadTokens: totalCache, finalState: state };
}
