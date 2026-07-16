// ─────────────────────────────────────────────────────────────────────────────
// HANOS API ROUTES — Add-to-Cart, product lookup, search, cart view
//
// All handlers use asyncHandler + AppError. Unhandled rejections forward to
// the global error handler in app.ts, which:
//   - emits an addBackendEvent('error', ...) telemetry record for >=500
//   - suppresses internal error messages in production
//   - returns `{ error: <message> }` JSON
// Per-handler logging stays as console.error so Railway logs still show the
// raw upstream message; safeErrMsg() redacts credentials before they reach
// the client.
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { errMsg, safeErrMsg, AppError, asyncHandler } from '../lib/config';
import { OCC_BASE, getCredentials, getClient, invalidateClient, formatProduct, resolveHanosAccount } from '../lib/hanos-client';
import { activeEventSlugs, isActiveLocation } from '../lib/locations';

const router = express.Router();

// ── Routes ──────────────────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  const west = getCredentials('west');
  const centraal = getCredentials('centraal');
  const westOk = !!(west.user && west.pass);
  const centraalOk = !!(centraal.user && centraal.pass);
  // Per-location map covering permanent + active event locations (an event
  // slug is configured iff the account it resolves to has credentials). The
  // flat west/centraal fields above it stay byte-identical for old clients.
  const locations: Record<string, { configured: boolean; account: 'west' | 'centraal' }> = {
    west: { configured: westOk, account: 'west' },
    centraal: { configured: centraalOk, account: 'centraal' },
  };
  for (const slug of activeEventSlugs()) {
    const account = resolveHanosAccount(slug);
    locations[slug] = { configured: account === 'centraal' ? centraalOk : westOk, account };
  }
  res.json({
    configured: westOk || centraalOk,
    west: westOk,
    centraal: centraalOk,
    locations,
    // Diagnostic: show credential presence only. Length removed to avoid
    // a side-channel signal about the client secret value.
    _diag: {
      westUser: !!west.user,
      westPass: !!west.pass,
      centraalUser: !!centraal.user,
      centraalPass: !!centraal.pass,
      clientSecret: !!process.env.HANOS_CLIENT_SECRET,
    },
  });
});

// Diagnostic: test login without adding to cart. Intentionally returns 200 with
// a custom { ok, error, location } shape rather than throwing, so the frontend
// status page can distinguish "configured but failing" from "not configured".
router.get('/test-login', asyncHandler(async (req: Request, res: Response) => {
  const loc = (req.query.location as string) || 'west';
  try {
    const creds = getCredentials(loc);
    if (!creds.user || !creds.pass) return res.json({ ok: false, error: `No credentials for ${loc}` });
    invalidateClient(loc); // force fresh login
    const client = await getClient(loc);
    res.json({ ok: true, hasToken: !!client.accessToken, hasCart: !!client.cartId });
  } catch (e: unknown) {
    console.error(`[Hanos] test-login (${loc}):`, errMsg(e));
    res.json({ ok: false, error: safeErrMsg(e), location: loc });
  }
}));

router.post('/add-to-cart', asyncHandler(async (req: Request, res: Response) => {
  const { items, location } = req.body;
  if (!Array.isArray(items) || !items.length) {
    throw new AppError(400, 'items array required');
  }
  const loc = (location as string) || 'west';
  // Only ACTIVE locations may order: resolveHanosAccount falls back to the
  // WEST account for unknown keys, so without this gate a stale client at a
  // deleted/archived event location would silently land items in West's
  // real Hanos cart with a success toast.
  if (!isActiveLocation(loc)) {
    throw new AppError(400, 'invalid location — this location is archived or unknown');
  }

  try {
    const client = await getClient(loc);
    const results: Array<{ orderCode: string; success: boolean; error?: string; name?: string; quantity?: unknown }> = [];

    for (const item of items) {
      const { orderCode, quantity, unit } = item;
      if (!orderCode) {
        results.push({ orderCode, success: false, error: 'No order code' });
        continue;
      }
      try {
        const data = await client.addToCart(orderCode, quantity || 1, unit || 'ST') as Record<string, unknown>;
        const entry = (data.entry || {}) as Record<string, unknown>;
        const product = (entry.product || {}) as Record<string, unknown>;
        results.push({
          orderCode,
          success: true,
          name: (product.formattedName || '') as string,
          quantity: entry.formattedQuantity || quantity,
        });
      } catch (e: unknown) {
        console.error(`[Hanos] Failed to add ${orderCode}:`, errMsg(e));
        results.push({ orderCode, success: false, error: safeErrMsg(e) });
      }
    }

    const ok = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    res.json({ ok, failed, total: results.length, results });
  } catch (e: unknown) {
    // Setup-time failure (e.g. login or token refresh threw). Drop the cached
    // client so the next call re-authenticates, then forward to the global
    // handler — it will telemeter and mask the message in production.
    console.error('[Hanos] add-to-cart setup error:', errMsg(e));
    invalidateClient(loc);
    throw e;
  }
}));

router.get('/product/:code', asyncHandler(async (req: Request, res: Response) => {
  const code = (req.params.code as string).trim();
  if (!code) throw new AppError(400, 'Product code required');

  const loc = (req.query.location as string) || 'west';
  const client = await getClient(loc);

  const url = `${OCC_BASE}/products/${encodeURIComponent(code)}?lang=en&curr=EUR&fields=FULL`;
  const resp = await fetch(url, {
    headers: client._headers(),
    signal: AbortSignal.timeout(15000),
  });

  if (resp.status === 401 && client.refreshToken) {
    await client._refreshAccessToken();
    const retry = await fetch(url, {
      headers: client._headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!retry.ok) {
      throw new AppError(retry.status, `Product not found (HTTP ${retry.status})`);
    }
    const product = await retry.json() as Record<string, unknown>;
    return res.json(formatProduct(product));
  }

  if (!resp.ok) {
    throw new AppError(resp.status, `Product not found (HTTP ${resp.status})`);
  }

  const product = await resp.json() as Record<string, unknown>;
  res.json(formatProduct(product));
}));

router.get('/search', asyncHandler(async (req: Request, res: Response) => {
  const query = ((req.query.q as string) || '').trim();
  if (!query) throw new AppError(400, 'Search query required');

  const loc = (req.query.location as string) || 'west';
  const client = await getClient(loc);

  const url = `${OCC_BASE}/products/search?query=${encodeURIComponent(query)}&pageSize=10&lang=en&curr=EUR&fields=FULL`;
  const resp = await fetch(url, {
    headers: client._headers(),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new AppError(resp.status, `Search failed (HTTP ${resp.status})`);
  }

  const data = await resp.json() as Record<string, unknown>;
  const products = ((data.products || []) as Array<Record<string, unknown>>).map(formatProduct);
  const pagination = data.pagination as Record<string, unknown> | undefined;
  res.json({ results: products, total: pagination ? pagination.totalResults : products.length });
}));

router.get('/cart', asyncHandler(async (req: Request, res: Response) => {
  const loc = (req.query.location as string) || 'west';
  try {
    const client = await getClient(loc);
    const cart = await client.getCart() as Record<string, unknown>;
    const entries = ((cart.entries || []) as Array<Record<string, unknown>>).map(e => {
      const p = (e.product || {}) as Record<string, unknown>;
      return {
        code: p.code,
        name: (p.formattedName || '?') as string,
        manufacturer: (p.formattedManufacturer || '') as string,
        quantity: e.formattedQuantity || '?',
      };
    });
    const totalPrice = (cart.totalPrice || {}) as Record<string, unknown>;
    res.json({
      cartId: client.cartId,
      totalItems: cart.totalItems || 0,
      total: (totalPrice.formattedValue || '?') as string,
      entries,
    });
  } catch (e: unknown) {
    console.error('[Hanos] cart error:', errMsg(e));
    invalidateClient(loc);
    throw e;
  }
}));

export default router;
