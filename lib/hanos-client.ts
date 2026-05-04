// ─────────────────────────────────────────────────────────────────────────────
// HANOS OCC v2 API CLIENT — OAuth login, cart management, product lookup
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { CONFIG } from './config';
import { parseHanosQuantityGrams } from './hanos-parser';

// ── Constants (from Hanos SPA JS bundle) ────────────────────────────────────

const BASE_URL = 'https://api.hanos.nl';
export const OCC_BASE = `${BASE_URL}/occ/v2/hanos-nl`;
const TOKEN_URL = `${BASE_URL}/authorizationserver/oauth/token`;

const CLIENT_ID = 'mobile_android';

const COMMON_HEADERS: Record<string, string> = {
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.hanos.nl',
  'Referer': 'https://www.hanos.nl/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-Anonymous-Consents': '%5B%5D',
};

// ── HanosClient ─────────────────────────────────────────────────────────────

export class HanosClient {
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

  async login(username: string, password: string, retryCount = 0): Promise<Record<string, unknown>> {
    if (!username || !password) throw new Error('Hanos credentials not configured for this location');
    if (!CONFIG.HANOS_CLIENT_SECRET) throw new Error('HANOS_CLIENT_SECRET env var not set');

    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: CLIENT_ID,
      client_secret: CONFIG.HANOS_CLIENT_SECRET,
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
      const err = await resp.json().catch(() => ({})) as Record<string, string>;
      const desc = err.error_description || 'Unknown error';
      throw new Error(`Hanos login failed: ${desc}`);
    }
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.error(`[Hanos] Login failed: HTTP ${resp.status} for user ${username.substring(0, 3)}*** — ${errBody}`);
      // Retry once on 401 (transient auth issue)
      if (resp.status === 401 && retryCount === 0) {
        console.log('[Hanos] Retrying login after 401...');
        await new Promise(r => setTimeout(r, 1000));
        return this.login(username, password, 1);
      }
      throw new Error(`Hanos login HTTP ${resp.status}${errBody ? ': ' + errBody.substring(0, 200) : ''}`);
    }

    const data = await resp.json() as Record<string, unknown>;
    this.accessToken = data.access_token as string;
    this.refreshToken = (data.refresh_token as string) || null;
    console.log(`[Hanos] Logged in (token expires in ${data.expires_in || '?'}s)`);
    return data;
  }

  async _refreshAccessToken() {
    if (!this.refreshToken) throw new Error('No refresh token — call login() first');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CONFIG.HANOS_CLIENT_SECRET,
      refresh_token: this.refreshToken,
    });

    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { ...COMMON_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Token refresh failed: HTTP ${resp.status}`);

    const data = await resp.json() as Record<string, unknown>;
    this.accessToken = data.access_token as string;
    this.refreshToken = (data.refresh_token as string) || this.refreshToken;
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

    const data = await resp.json() as Record<string, unknown>;
    const carts = (data.carts as Array<Record<string, unknown>>) || [];

    if (carts.length) {
      this.cartId = carts[0].code as string;
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

    const cart = await createResp.json() as Record<string, unknown>;
    this.cartId = cart.code as string;
    console.log(`[Hanos] Created cart ${this.cartId}`);
    return this.cartId;
  }

  async addToCart(productCode: string, quantity = 1, unitCode = 'ST'): Promise<Record<string, unknown>> {
    if (!this.cartId) await this.getOrCreateCart();

    const send = () => {
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
      return fetch(url, {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    };

    let resp = await send();

    if (resp.status === 401 && this.refreshToken) {
      await this._refreshAccessToken();
      resp = await send();
    }

    // Stale-cart recovery: Hanos returns 400 CartError/notFound when the cached
    // cartId no longer exists (cart was emptied, expired, or finalized into an
    // order). Drop the stale cartId, mint a new one, and retry once. Later
    // items in the same bulk call reuse the new cartId.
    if (resp.status === 400) {
      const errBody = await resp.text().catch(() => '');
      if (/"subjectType"\s*:\s*"cart"/.test(errBody) && /"reason"\s*:\s*"notFound"/.test(errBody)) {
        console.log(`[Hanos] Cart ${this.cartId} not found — recreating and retrying`);
        this.cartId = null;
        await this.getOrCreateCart();
        resp = await send();
      } else {
        throw new Error(`Add to cart HTTP 400 — ${errBody}`);
      }
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Add to cart HTTP ${resp.status} — ${errBody}`);
    }

    const data = await resp.json() as Record<string, unknown>;
    const entry = (data.entry || {}) as Record<string, unknown>;
    const product = (entry.product || {}) as Record<string, unknown>;
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

export function getCredentials(location: string) {
  const loc = (location || '').toLowerCase();
  if (loc === 'centraal') {
    return { user: CONFIG.HANOS_USER_CENTRAAL, pass: CONFIG.HANOS_PASS_CENTRAAL };
  }
  return { user: CONFIG.HANOS_USER_WEST, pass: CONFIG.HANOS_PASS_WEST };
}

// ── Per-location singleton clients ──────────────────────────────────────────

const _clients: Record<string, HanosClient> = {};
const _clientTimes: Record<string, number> = {};
const CLIENT_TTL = 10 * 60 * 1000;

export async function getClient(location: string) {
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

export function invalidateClient(location: string) {
  const loc = (location || 'west').toLowerCase();
  delete _clients[loc];
  delete _clientTimes[loc];
}

// ── Product formatter ───────────────────────────────────────────────────────

export function formatProduct(p: Record<string, unknown>) {
  const priceObj = p.price as Record<string, unknown> | undefined;
  const price = priceObj ? priceObj.value as number : null;
  const priceFormatted = priceObj ? priceObj.formattedValue as string : '';

  const contentUnit = (p.contentUnit || '') as string;
  const numUnits = (p.numbercontentunits || 0) as number;
  const netWeight = (p.netWeight || 0) as number;

  let orderUnit = (p.priceUnitLabel || '') as string;
  if (!orderUnit && numUnits && contentUnit) {
    orderUnit = `${numUnits} ${contentUnit}`;
  }

  let unitSizeGrams = netWeight;
  if (!unitSizeGrams && orderUnit) {
    unitSizeGrams = parseHanosQuantityGrams(orderUnit);
  }
  if (!unitSizeGrams && p.formattedName) {
    unitSizeGrams = parseHanosQuantityGrams(p.formattedName as string);
  }

  const isLiquid = contentUnit === 'liter' || contentUnit === 'ml'
    || ((p.formattedName || '') as string).toLowerCase().includes('liter');

  const categories = ((p.categories || []) as Array<Record<string, string>>)
    .map(c => c.name || c.code || '').filter(Boolean);

  const aums = ((p.aums || p.orderableAums || []) as Array<Record<string, unknown>>).map(a => ({
    unitName: (a.unitName || '') as string,
    conversionFactor: (a.conversionFactor || 1) as number,
    description: ((a.formattedName || a.description || '') as string),
  }));

  const allergens: string[] = [];
  const classifications = (p.classifications || []) as Array<Record<string, unknown>>;
  classifications.forEach(cl => {
    ((cl.features || []) as Array<Record<string, unknown>>).forEach(feat => {
      if (!feat.code || !(feat.code as string).includes('Allergens')) return;
      const featureValues = feat.featureValues as Array<Record<string, string>> | undefined;
      const val = featureValues && featureValues[0] ? featureValues[0].value : '';
      if (val && val.toLowerCase().includes('with') && !val.toLowerCase().includes('without')) {
        allergens.push((feat.name || '') as string);
      }
    });
  });

  console.log(`[Hanos] Product ${p.code}: "${p.formattedName}", unit="${orderUnit}", netWeight=${netWeight}g, price=${price}, allergens=${allergens.join(',')}`);

  return {
    code: (p.code || '') as string,
    name: ((p.formattedName || p.name || '') as string),
    supplierName: (p.formattedName || '') as string,
    manufacturer: ((p.formattedManufacturer || p.manufacturer || '') as string),
    orderCode: (p.code || '') as string,
    orderUnit,
    orderUnitSize: unitSizeGrams,
    orderPrice: price,
    priceFormatted,
    unit: isLiquid ? 'ML' : 'Grams',
    categories,
    allergens: allergens.join(', '),
    aums,
    imageUrl: (p.images as Array<Record<string, string>> | undefined)?.[0]?.url || '',
    supplier: 'Hanos',
  };
}
