// ─────────────────────────────────────────────────────────────────────────────
// HANOS API CLIENT — Add-to-Cart via OCC v2
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { parseHanosQuantityGrams } from '../lib/hanos-parser';
import { errMsg } from '../lib/config';

const router = express.Router();

// ── Constants (from Hanos SPA JS bundle) ────────────────────────────────────

const BASE_URL = 'https://api.hanos.nl';
const OCC_BASE = `${BASE_URL}/occ/v2/hanos-nl`;
const TOKEN_URL = `${BASE_URL}/authorizationserver/oauth/token`;

const CLIENT_ID = 'mobile_android';
const CLIENT_SECRET = 'Qi9#Ze!TqhiQybhdRMDJbP&uz87RBck&*Zr2YBmr';

const COMMON_HEADERS: Record<string, string> = {
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.hanos.nl',
  'Referer': 'https://www.hanos.nl/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-Anonymous-Consents': '%5B%5D',
};

// ── HanosClient ─────────────────────────────────────────────────────────────

class HanosClient {
  accessToken: string | null = null;
  refreshToken: string | null = null;
  personalizationId: string | null = null;
  cartId: string | null = null;

  _headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { ...COMMON_HEADERS, ...extra };
    if (this.accessToken) h['Authorization'] = `Bearer ${this.accessToken}`;
    if (this.personalizationId) h['occ-personalization-id'] = this.personalizationId;
    return h;
  }

  async login(username: string, password: string) {
    if (!username || !password) throw new Error('Hanos credentials not configured for this location');

    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      username,
      password,
    });

    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { ...COMMON_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (resp.status === 400) {
      const err = await resp.json().catch(() => ({})) as any;
      const desc = err.error_description || 'Unknown error';
      throw new Error(`Hanos login failed: ${desc}`);
    }
    if (!resp.ok) throw new Error(`Hanos login HTTP ${resp.status}`);

    const data = await resp.json() as any;
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token || null;
    console.log(`[Hanos] Logged in (token expires in ${data.expires_in || '?'}s)`);
    return data;
  }

  async _refreshAccessToken() {
    if (!this.refreshToken) throw new Error('No refresh token — call login() first');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: this.refreshToken,
    });

    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { ...COMMON_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Token refresh failed: HTTP ${resp.status}`);

    const data = await resp.json() as any;
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token || this.refreshToken;
    console.log(`[Hanos] Token refreshed`);
    return data;
  }

  async fetchPersonalizationId() {
    if (this.personalizationId) return this.personalizationId;

    const resp = await fetch(`${OCC_BASE}/cms/pages?pageType=ContentPage&pageLabelOrId=/&lang=en&curr=EUR`, {
      headers: this._headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Personalization fetch HTTP ${resp.status}`);

    this.personalizationId = resp.headers.get('occ-personalization-id');
    if (!this.personalizationId) {
      this.personalizationId = crypto.randomUUID();
      console.log(`[Hanos] Generated personalization ID: ${this.personalizationId}`);
    } else {
      console.log(`[Hanos] Personalization ID: ${this.personalizationId}`);
    }
    return this.personalizationId;
  }

  async getOrCreateCart() {
    const resp = await fetch(`${OCC_BASE}/hanosUsers/current/carts?lang=en&curr=EUR&fields=FULL`, {
      headers: this._headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Cart fetch HTTP ${resp.status}`);

    const data = await resp.json() as any;
    const carts = data.carts || [];

    if (carts.length) {
      this.cartId = carts[0].code;
      console.log(`[Hanos] Found cart ${this.cartId} (${carts[0].totalItems || 0} items)`);
      return this.cartId;
    }

    const createResp = await fetch(`${OCC_BASE}/hanosUsers/current/carts?lang=en&curr=EUR`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    });
    if (!createResp.ok) throw new Error(`Cart create HTTP ${createResp.status}`);

    const cart = await createResp.json() as any;
    this.cartId = cart.code;
    console.log(`[Hanos] Created cart ${this.cartId}`);
    return this.cartId;
  }

  async addToCart(productCode: string, quantity = 1, unitCode = 'ST') {
    if (!this.cartId) await this.getOrCreateCart();

    const url = `${OCC_BASE}/hanosUsers/current/carts/${this.cartId}/entries?lang=en&curr=EUR&defaultUnit=15975108`;
    const payload = {
      product: { code: productCode },
      note: '',
      aumQuantities: [{
        formattedQuantity: quantity,
        conversionFactor: 1,
        unitCode,
        unitName: unitCode === 'COL' ? 'carton' : 'Bin',
      }],
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    if (resp.status === 401 && this.refreshToken) {
      await this._refreshAccessToken();
      const retry = await fetch(url, {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (!retry.ok) {
        const errBody = await retry.text().catch(() => '');
        throw new Error(`Add to cart failed after refresh: HTTP ${retry.status} — ${errBody}`);
      }
      return await retry.json();
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Add to cart HTTP ${resp.status} — ${errBody}`);
    }

    const data = await resp.json() as any;
    const entry = data.entry || {};
    const product = entry.product || {};
    console.log(`[Hanos] Added ${quantity}x ${product.formattedName || productCode}`);
    return data;
  }

  async getCart() {
    if (!this.cartId) await this.getOrCreateCart();

    const resp = await fetch(
      `${OCC_BASE}/hanosUsers/current/carts/${this.cartId}?requestQuoteForSessionCart=false&lang=en&curr=EUR&fields=FULL`,
      { headers: this._headers(), signal: AbortSignal.timeout(15000) }
    );
    if (!resp.ok) throw new Error(`Cart fetch HTTP ${resp.status}`);
    return await resp.json();
  }

  async init(username: string, password: string) {
    await this.login(username, password);
    await this.fetchPersonalizationId();
    await this.getOrCreateCart();
  }
}

// ── Per-location credentials ────────────────────────────────────────────────

function getCredentials(location: string) {
  const loc = (location || '').toLowerCase();
  if (loc === 'centraal') {
    return { user: process.env.HANOS_USER_CENTRAAL, pass: process.env.HANOS_PASS_CENTRAAL };
  }
  return { user: process.env.HANOS_USER_WEST, pass: process.env.HANOS_PASS_WEST };
}

// ── Per-location singleton clients ──────────────────────────────────────────

const _clients: Record<string, HanosClient> = {};
const _clientTimes: Record<string, number> = {};
const CLIENT_TTL = 10 * 60 * 1000;

async function getClient(location: string) {
  const loc = (location || 'west').toLowerCase();
  const now = Date.now();
  if (_clients[loc] && (now - (_clientTimes[loc] || 0)) < CLIENT_TTL) return _clients[loc];

  const { user, pass } = getCredentials(loc);
  if (!user || !pass) throw new Error(`Hanos credentials not configured for ${loc}`);

  const client = new HanosClient();
  await client.init(user, pass);
  _clients[loc] = client;
  _clientTimes[loc] = now;
  return client;
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response) => {
  const west = getCredentials('west');
  const centraal = getCredentials('centraal');
  res.json({
    configured: !!(west.user && west.pass) || !!(centraal.user && centraal.pass),
    west: !!(west.user && west.pass),
    centraal: !!(centraal.user && centraal.pass),
  });
});

router.post('/add-to-cart', async (req: Request, res: Response) => {
  try {
    const { items, location } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items array required' });
    }

    const client = await getClient(location || 'west');
    const results: any[] = [];

    for (const item of items) {
      const { orderCode, quantity, unit } = item;
      if (!orderCode) {
        results.push({ orderCode, success: false, error: 'No order code' });
        continue;
      }
      try {
        const data = await client.addToCart(orderCode, quantity || 1, unit || 'ST') as any;
        const entry = data.entry || {};
        const product = entry.product || {};
        results.push({
          orderCode,
          success: true,
          name: product.formattedName || '',
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
    const loc = (req.body.location || 'west').toLowerCase();
    delete _clients[loc];
    delete _clientTimes[loc];
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
      const product = await retry.json();
      return res.json(formatProduct(product));
    }

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Product not found (HTTP ${resp.status})` });
    }

    const product = await resp.json();
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

    const data = await resp.json() as any;
    const products = (data.products || []).map(formatProduct);
    res.json({ results: products, total: data.pagination ? data.pagination.totalResults : products.length });
  } catch (e: unknown) {
    console.error('[Hanos] search error:', errMsg(e));
    res.status(500).json({ error: errMsg(e) });
  }
});

function formatProduct(p: any) {
  const price = p.price ? p.price.value : null;
  const priceFormatted = p.price ? p.price.formattedValue : '';

  const contentUnit = p.contentUnit || '';
  const numUnits = p.numbercontentunits || 0;
  const netWeight = p.netWeight || 0;

  let orderUnit = p.priceUnitLabel || '';
  if (!orderUnit && numUnits && contentUnit) {
    orderUnit = `${numUnits} ${contentUnit}`;
  }

  let unitSizeGrams = netWeight;
  if (!unitSizeGrams && orderUnit) {
    unitSizeGrams = parseHanosQuantityGrams(orderUnit);
  }
  if (!unitSizeGrams && p.formattedName) {
    unitSizeGrams = parseHanosQuantityGrams(p.formattedName);
  }

  const isLiquid = contentUnit === 'liter' || contentUnit === 'ml'
    || (p.formattedName || '').toLowerCase().includes('liter');

  const categories = (p.categories || []).map((c: any) => c.name || c.code || '').filter(Boolean);

  const aums = (p.aums || p.orderableAums || []).map((a: any) => ({
    unitName: a.unitName || '',
    conversionFactor: a.conversionFactor || 1,
    description: a.formattedName || a.description || '',
  }));

  const allergens: string[] = [];
  const classifications = p.classifications || [];
  classifications.forEach((cl: any) => {
    (cl.features || []).forEach((feat: any) => {
      if (!feat.code || !feat.code.includes('Allergens')) return;
      const val = feat.featureValues && feat.featureValues[0] ? feat.featureValues[0].value : '';
      if (val && val.toLowerCase().includes('with') && !val.toLowerCase().includes('without')) {
        allergens.push(feat.name || '');
      }
    });
  });

  console.log(`[Hanos] Product ${p.code}: "${p.formattedName}", unit="${orderUnit}", netWeight=${netWeight}g, price=${price}, allergens=${allergens.join(',')}`);

  return {
    code: p.code || '',
    name: p.formattedName || p.name || '',
    supplierName: p.formattedName || '',
    manufacturer: p.formattedManufacturer || p.manufacturer || '',
    orderCode: p.code || '',
    orderUnit,
    orderUnitSize: unitSizeGrams,
    orderPrice: price,
    priceFormatted,
    unit: isLiquid ? 'ML' : 'Grams',
    categories,
    allergens: allergens.join(', '),
    aums,
    imageUrl: p.images && p.images.length ? p.images[0].url : '',
    supplier: 'Hanos',
  };
}

router.get('/cart', async (req: Request, res: Response) => {
  try {
    const client = await getClient((req.query.location as string) || 'west');
    const cart = await client.getCart() as any;
    const entries = (cart.entries || []).map((e: any) => {
      const p = e.product || {};
      return {
        code: p.code,
        name: p.formattedName || '?',
        manufacturer: p.formattedManufacturer || '',
        quantity: e.formattedQuantity || '?',
      };
    });
    res.json({
      cartId: client.cartId,
      totalItems: cart.totalItems || 0,
      total: (cart.totalPrice || {}).formattedValue || '?',
      entries,
    });
  } catch (e: unknown) {
    console.error('[Hanos] cart error:', errMsg(e));
    const loc = ((req.query.location as string) || 'west').toLowerCase();
    delete _clients[loc];
    delete _clientTimes[loc];
    res.status(500).json({ error: errMsg(e) });
  }
});

export default router;
