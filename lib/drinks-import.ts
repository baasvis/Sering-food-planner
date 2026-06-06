// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — AI menu/price-list import. Sends an uploaded PDF to Claude (native
// PDF document block) and extracts a structured product + price list the user
// reviews before adding to the catalogue. Mirrors lib/recipe-ai.ts for the SDK
// access (dynamic import, ANTHROPIC_API_KEY, AI_ANALYSIS_MODEL).
// ─────────────────────────────────────────────────────────────────────────────

import type Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.AI_ANALYSIS_MODEL || 'claude-sonnet-4-6';

/** Allowed catalogue categories Claude may classify into (matches the UI). */
const IMPORT_CATEGORIES = ['beer', 'wine', 'spirits', 'soft', 'coffee-tea-stock', 'consumables', 'glassware'] as const;

export interface ImportItem {
  name: string;
  category: string;
  subtype?: string;
  abv?: number | null;
  price?: number | null;
}

export function importConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Extract products + prices from a base64 PDF. Returns [] if nothing found. */
export async function scanMenuPdf(pdfBase64: string): Promise<ImportItem[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
  const client = new AnthropicSDK({ apiKey });

  const tool: Anthropic.Tool = {
    name: 'record_products',
    description: 'Record every drink / product found on the menu or supplier price list, with its price.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Product name as printed' },
              category: { type: 'string', enum: IMPORT_CATEGORIES as unknown as string[], description: 'Closest catalogue category' },
              subtype: { type: 'string', description: 'e.g. IPA, red, gin — optional' },
              abv: { type: 'number', description: 'Alcohol % if shown/known, else omit' },
              price: { type: 'number', description: 'Price in euros (incl. BTW). Omit if no price shown.' },
            },
            required: ['name'],
          },
        },
      },
      required: ['items'],
    },
  };

  const message: Anthropic.MessageParam = {
    role: 'user',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
      {
        type: 'text',
        text: 'This PDF is a drinks menu or supplier price list. Extract EVERY product and its price. '
          + 'Classify each into the closest category. Prices are in euros, including BTW. '
          + 'If a line has no price, include the product but omit the price. '
          + 'Call record_products once with the complete list.',
      },
    ],
  };

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'record_products' },
    messages: [message],
  });

  const block = resp.content.find((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
  if (!block) return [];
  const input = block.input as { items?: ImportItem[] };
  if (!Array.isArray(input.items)) return [];
  return input.items
    .filter((i): i is ImportItem => !!i && typeof i.name === 'string' && i.name.trim().length > 0)
    .map(i => ({
      name: String(i.name).trim(),
      category: IMPORT_CATEGORIES.includes(i.category as typeof IMPORT_CATEGORIES[number]) ? i.category : 'soft',
      subtype: typeof i.subtype === 'string' ? i.subtype : '',
      abv: typeof i.abv === 'number' ? i.abv : null,
      price: typeof i.price === 'number' ? i.price : null,
    }));
}
