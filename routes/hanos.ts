// ─────────────────────────────────────────────────────────────────────────────
// HANOS API ROUTES — Add-to-Cart, product lookup, search, cart view
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { errMsg } from '../lib/config';
import { OCC_BASE, getCredentials, getClient, invalidateClient, formatProduct } from '../lib/hanos-client';

const router = express.Router();

// ── Routes ──────────────────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  const west = getCredentials('west');
  const centraal = getCredentials('centraal');
  res.json({
    configured: !!(west.user && west.pass) || !!(centraal.user && centraal.pass),
    west: !!(west.user && west.pass),
    centraal: !!(centraal.user && centraal.pass),
    // Diagnostic: show credential presence (not values) and client_secret presence
    _diag: {
      westUser: !!west.user,
      westPass: !!west.pass,
      centraalUser: !!centraal.user,
      centraalPass: !!centraal.pass,
      clientSecret: !!process.env.HANOS_CLIENT_SECRET,
      clientSecretLen: (process.env.HANOS_CLIENT_SECRET || '').length,
    },
  });
});

// Diagnostic: test login without adding to cart
router.get('/test-login', async (req: Request, res: Response) => {
  const loc = (req.query.location as string) || 'west';
  try {
    const creds = getCredentials(loc);
    if (!creds.user || !creds.pass) return res.json({ ok: false, error: `No credentials for ${loc}` });
    invalidateClient(loc); // force fresh login
    const client = await getClient(loc);
    res.json({ ok: true, hasToken: !!client.accessToken, hasCart: !!client.cartId });
  } catch (e: unknown) {
    res.json({ ok: false, error: errMsg(e), location: loc });
  }
});

router.post('/add-to-cart', async (req: Request, res: Response) => {
  try {
    const { items, location } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items array required' });
    }

    const client = await getClient(location || 'west');
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
        results.push({ orderCode, success: false, error: errMsg(e) });
      }
    }

    const ok = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    res.json({ ok, failed, total: results.length, results });
  } catch (e: unknown) {
    console.error('[Hanos] add-to-cart error:', errMsg(e));
    invalidateClient(req.body.location || 'west');
    res.status(500).json({ error: errMsg(e) });
  }
});

router.get('/product/:code', async (req: Request, res: Response) => {
  try {
    const code = (req.params.code as string).trim();
    if (!code) return res.status(400).json({ error: 'Product code required' });

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
        return res.status(retry.status).json({ error: `Product not found (HTTP ${retry.status})` });
      }
      const product = await retry.json() as Record<string, unknown>;
      return res.json(formatProduct(product));
    }

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Product not found (HTTP ${resp.status})` });
    }

    const product = await resp.json() as Record<string, unknown>;
    res.json(formatProduct(product));
  } catch (e: unknown) {
    console.error('[Hanos] product lookup error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

router.get('/search', async (req: Request, res: Response) => {
  try {
    const query = ((req.query.q as string) || '').trim();
    if (!query) return res.status(400).json({ error: 'Search query required' });

    const loc = (req.query.location as string) || 'west';
    const client = await getClient(loc);

    const url = `${OCC_BASE}/products/search?query=${encodeURIComponent(query)}&pageSize=10&lang=en&curr=EUR&fields=FULL`;
    const resp = await fetch(url, {
      headers: client._headers(),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Search failed (HTTP ${resp.status})` });
    }

    const data = await resp.json() as Record<string, unknown>;
    const products = ((data.products || []) as Array<Record<string, unknown>>).map(formatProduct);
    const pagination = data.pagination as Record<string, unknown> | undefined;
    res.json({ results: products, total: pagination ? pagination.totalResults : products.length });
  } catch (e: unknown) {
    console.error('[Hanos] search error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

router.get('/cart', async (req: Request, res: Response) => {
  try {
    const client = await getClient((req.query.location as string) || 'west');
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
    invalidateClient((req.query.location as string) || 'west');
    res.status(500).json({ error: errMsg(e) });
  }
});

export default router;
