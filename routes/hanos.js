// ─────────────────────────────────────────────────────────────────────────────
// HANOS API CLIENT — Add-to-Cart via OCC v2
// ─────────────────────────────────────────────────────────────────────────────
//
// Ported from hanos_add_to_cart.py. The Hanos webshop runs on SAP Commerce
// Cloud (OCC v2) with OAuth 2.0. This module handles:
//   1. OAuth password-grant login
//   2. Personalization ID retrieval
//   3. Cart find-or-create
//   4. Adding products to cart
//
// Credentials come from env vars HANOS_USER + HANOS_PASS (shared org account).

const express = require('express');
const router = express.Router();

// ── Constants (from Hanos SPA JS bundle) ────────────────────────────────────

const BASE_URL = 'https://api.hanos.nl';
const OCC_BASE = `${BASE_URL}/occ/v2/hanos-nl`;
const TOKEN_URL = `${BASE_URL}/authorizationserver/oauth/token`;

// OAuth client credentials (public — embedded in the Hanos SPA)
const CLIENT_ID = 'mobile_android';
const CLIENT_SECRET = 'Qi9#Ze!TqhiQybhdRMDJbP&uz87RBck&*Zr2YBmr';

const COMMON_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.hanos.nl',
  'Referer': 'https://www.hanos.nl/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-Anonymous-Consents': '%5B%5D',
};

// ── HanosClient ─────────────────────────────────────────────────────────────

class HanosClient {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.personalizationId = null;
    this.cartId = null;
  }

  /** Build headers for OCC requests */
  _headers(extra = {}) {
    const h = { ...COMMON_HEADERS, ...extra };
    if (this.accessToken) h['Authorization'] = `Bearer ${this.accessToken}`;
    if (this.personalizationId) h['occ-personalization-id'] = this.personalizationId;
    return h;
  }

  /** OAuth password-grant login */
  async login(username, password) {
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
      const err = await resp.json().catch(() => ({}));
      const desc = err.error_description || 'Unknown error';
      throw new Error(`Hanos login failed: ${desc}`);
    }
    if (!resp.ok) throw new Error(`Hanos login HTTP ${resp.status}`);

    const data = await resp.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token || null;
    console.log(`[Hanos] Logged in (token expires in ${data.expires_in || '?'}s)`);
    return data;
  }

  /** Use refresh token to get a new access token */
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

    const data = await resp.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token || this.refreshToken;
    console.log(`[Hanos] Token refreshed`);
    return data;
  }

  /** Fetch personalization ID from server headers */
  async fetchPersonalizationId() {
    if (this.personalizationId) return this.personalizationId;

    const resp = await fetch(`${OCC_BASE}/cms/pages?pageType=ContentPage&pageLabelOrId=/&lang=en&curr=EUR`, {
      headers: this._headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Personalization fetch HTTP ${resp.status}`);

    this.personalizationId = resp.headers.get('occ-personalization-id');
    if (!this.personalizationId) {
      const crypto = require('crypto');
      this.personalizationId = crypto.randomUUID();
      console.log(`[Hanos] Generated personalization ID: ${this.personalizationId}`);
    } else {
      console.log(`[Hanos] Personalization ID: ${this.personalizationId}`);
    }
    return this.personalizationId;
  }

  /** Get active cart or create a new one */
  async getOrCreateCart() {
    const resp = await fetch(`${OCC_BASE}/hanosUsers/current/carts?lang=en&curr=EUR&fields=FULL`, {
      headers: this._headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Cart fetch HTTP ${resp.status}`);

    const data = await resp.json();
    const carts = data.carts || [];

    if (carts.length) {
      this.cartId = carts[0].code;
      console.log(`[Hanos] Found cart ${this.cartId} (${carts[0].totalItems || 0} items)`);
      return this.cartId;
    }

    // Create new cart
    const createResp = await fetch(`${OCC_BASE}/hanosUsers/current/carts?lang=en&curr=EUR`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    });
    if (!createResp.ok) throw new Error(`Cart create HTTP ${createResp.status}`);

    const cart = await createResp.json();
    this.cartId = cart.code;
    console.log(`[Hanos] Created cart ${this.cartId}`);
    return this.cartId;
  }

  /** Add a product to the active cart */
  async addToCart(productCode, quantity = 1, unitCode = 'ST') {
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
      // Token expired — refresh and retry
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

    const data = await resp.json();
    const entry = data.entry || {};
    const product = entry.product || {};
    console.log(`[Hanos] Added ${quantity}x ${product.formattedName || productCode}`);
    return data;
  }

  /** Fetch full cart contents */
  async getCart() {
    if (!this.cartId) await this.getOrCreateCart();

    const resp = await fetch(
      `${OCC_BASE}/hanosUsers/current/carts/${this.cartId}?requestQuoteForSessionCart=false&lang=en&curr=EUR&fields=FULL`,
      { headers: this._headers(), signal: AbortSignal.timeout(15000) }
    );
    if (!resp.ok) throw new Error(`Cart fetch HTTP ${resp.status}`);
    return await resp.json();
  }

  /** Initialize: login → personalization → cart */
  async init(username, password) {
    await this.login(username, password);
    await this.fetchPersonalizationId();
    await this.getOrCreateCart();
  }
}

// ── Per-location credentials ────────────────────────────────────────────────

function getCredentials(location) {
  const loc = (location || '').toLowerCase();
  if (loc === 'centraal') {
    return { user: process.env.HANOS_USER_CENTRAAL, pass: process.env.HANOS_PASS_CENTRAAL };
  }
  // Default to west
  return { user: process.env.HANOS_USER_WEST, pass: process.env.HANOS_PASS_WEST };
}

// ── Per-location singleton clients ──────────────────────────────────────────

const _clients = {};       // { west: HanosClient, centraal: HanosClient }
const _clientTimes = {};   // { west: timestamp, centraal: timestamp }
const CLIENT_TTL = 10 * 60 * 1000; // 10 minutes

async function getClient(location) {
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

/** GET /api/hanos/status — check which locations have credentials configured */
router.get('/status', (req, res) => {
  const west = getCredentials('west');
  const centraal = getCredentials('centraal');
  res.json({
    configured: !!(west.user && west.pass) || !!(centraal.user && centraal.pass),
    west: !!(west.user && west.pass),
    centraal: !!(centraal.user && centraal.pass),
  });
});

/** POST /api/hanos/add-to-cart — add items to Hanos cart */
router.post('/add-to-cart', async (req, res) => {
  try {
    const { items, location } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items array required' });
    }

    const client = await getClient(location || 'west');
    const results = [];

    for (const item of items) {
      const { orderCode, quantity, unit } = item;
      if (!orderCode) {
        results.push({ orderCode, success: false, error: 'No order code' });
        continue;
      }
      try {
        const data = await client.addToCart(orderCode, quantity || 1, unit || 'ST');
        const entry = data.entry || {};
        const product = entry.product || {};
        results.push({
          orderCode,
          success: true,
          name: product.formattedName || '',
          quantity: entry.formattedQuantity || quantity,
        });
      } catch (e) {
        console.error(`[Hanos] Failed to add ${orderCode}:`, e.message);
        results.push({ orderCode, success: false, error: e.message });
      }
    }

    const ok = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    res.json({ ok, failed, total: results.length, results });
  } catch (e) {
    console.error('[Hanos] add-to-cart error:', e.message);
    // Reset client on auth failure
    const loc = (req.body.location || 'west').toLowerCase();
    delete _clients[loc];
    delete _clientTimes[loc];
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/hanos/product/:code — fetch product details by order code */
router.get('/product/:code', async (req, res) => {
  try {
    const code = req.params.code.trim();
    if (!code) return res.status(400).json({ error: 'Product code required' });

    // Use any available location for lookup
    const loc = req.query.location || 'west';
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
  } catch (e) {
    console.error('[Hanos] product lookup error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/hanos/search — search Hanos product catalog */
router.get('/search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    if (!query) return res.status(400).json({ error: 'Search query required' });

    const loc = req.query.location || 'west';
    const client = await getClient(loc);

    const url = `${OCC_BASE}/products/search?query=${encodeURIComponent(query)}&pageSize=10&lang=en&curr=EUR&fields=FULL`;
    const resp = await fetch(url, {
      headers: client._headers(),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Search failed (HTTP ${resp.status})` });
    }

    const data = await resp.json();
    const products = (data.products || []).map(formatProduct);
    res.json({ results: products, total: data.pagination ? data.pagination.totalResults : products.length });
  } catch (e) {
    console.error('[Hanos] search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** Format a Hanos product response into our ingredient fields */
function formatProduct(p) {
  const { parseHanosQuantityGrams } = require('../lib/hanos-parser');

  // Extract price — try multiple locations
  const price = p.price ? p.price.value : (p.pricePerUnit ? p.pricePerUnit.value : null);
  const priceFormatted = p.price ? p.price.formattedValue : '';

  // Extract unit info — try many possible field names from SAP OCC v2
  const hoeveelheid = p.formattedHoeveelheid || p.hoeveelheid
    || p.contentUnit || p.salesUnit || p.unit || '';

  // Also try to get quantity from AUM (alternative units of measure) data
  const aums = p.aumDataList || p.aums || [];
  let aumUnit = '';
  if (aums.length && !hoeveelheid) {
    const firstAum = aums[0];
    aumUnit = firstAum.formattedName || firstAum.description || firstAum.unitName || '';
  }

  const unitStr = hoeveelheid || aumUnit || '';
  let unitSizeGrams = parseHanosQuantityGrams(unitStr);

  // If no hoeveelheid found, try to extract from formattedName
  // e.g. "Winterpeen kist 10 kilogram" → "kist 10 kilogram"
  if (!unitSizeGrams && p.formattedName) {
    unitSizeGrams = parseHanosQuantityGrams(p.formattedName);
  }

  // Determine base unit (grams vs ml)
  const combined = (unitStr + ' ' + (p.formattedName || '')).toLowerCase();
  const isLiquid = combined.includes('liter') || combined.includes(' ml');

  // Get category from Hanos categories
  const categories = (p.categories || []).map(c => c.name || c.code || '').filter(Boolean);

  // Log raw product keys for debugging (first time only)
  console.log(`[Hanos] Product ${p.code}: keys=${Object.keys(p).join(',')}, hoeveelheid="${unitStr}", unitSize=${unitSizeGrams}, price=${price}`);

  return {
    code: p.code || '',
    name: p.formattedName || p.name || '',
    supplierName: p.formattedName || '',
    manufacturer: p.formattedManufacturer || '',
    orderCode: p.code || '',
    orderUnit: unitStr || '',
    orderUnitSize: unitSizeGrams,
    orderPrice: price,
    priceFormatted,
    hoeveelheid: unitStr,
    unit: isLiquid ? 'ML' : 'Grams',
    categories,
    imageUrl: p.images && p.images.length ? p.images[0].url : '',
    supplier: 'Hanos',
    _rawKeys: Object.keys(p), // for debugging
  };
}

/** GET /api/hanos/cart — view current Hanos cart */
router.get('/cart', async (req, res) => {
  try {
    const client = await getClient(req.query.location || 'west');
    const cart = await client.getCart();
    const entries = (cart.entries || []).map(e => {
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
  } catch (e) {
    console.error('[Hanos] cart error:', e.message);
    const loc = (req.query.location || 'west').toLowerCase();
    delete _clients[loc];
    delete _clientTimes[loc];
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
