// Tests for Tebi scraper pure functions and finance sync API.
//
// The scraper functions are pure (no I/O) so they're imported directly.
// The sync API tests use supertest and exercise the route boundary
// (without spawning a real browser).

try { require('dotenv').config(); } catch (_e) {}
const request = require('supertest');
const app = require('../app').default;

// Import scraper pure functions via CommonJS
const {
  classifyServicePeriod,
  sumMetric,
  formatProductRevenue,
  formatResults,
} = require('../scripts/tebi-scraper');

// ── classifyServicePeriod ────────────────────────────────────────────────────

describe('classifyServicePeriod', () => {
  // Timestamps without timezone are parsed as LOCAL time by Date; Node.js
  // test runners default to UTC, so hours below match that assumption.

  it('returns other for null/empty/undefined', () => {
    expect(classifyServicePeriod(null)).toBe('other');
    expect(classifyServicePeriod('')).toBe('other');
    expect(classifyServicePeriod(undefined)).toBe('other');
  });

  it('returns morning for 06:00–11:59', () => {
    expect(classifyServicePeriod('2026-04-13T06:00:00')).toBe('morning');
    expect(classifyServicePeriod('2026-04-13T09:30:00')).toBe('morning');
    expect(classifyServicePeriod('2026-04-13T11:59:00')).toBe('morning');
  });

  it('returns lunch for 12:00–13:59', () => {
    expect(classifyServicePeriod('2026-04-13T12:00:00')).toBe('lunch');
    expect(classifyServicePeriod('2026-04-13T13:00:00')).toBe('lunch');
    expect(classifyServicePeriod('2026-04-13T13:59:00')).toBe('lunch');
  });

  it('returns afternoon for 14:00–17:59', () => {
    expect(classifyServicePeriod('2026-04-13T14:00:00')).toBe('afternoon');
    expect(classifyServicePeriod('2026-04-13T16:00:00')).toBe('afternoon');
    expect(classifyServicePeriod('2026-04-13T17:59:00')).toBe('afternoon');
  });

  it('returns dinner for 18:00–20:59', () => {
    expect(classifyServicePeriod('2026-04-13T18:00:00')).toBe('dinner');
    expect(classifyServicePeriod('2026-04-13T19:30:00')).toBe('dinner');
    expect(classifyServicePeriod('2026-04-13T20:59:00')).toBe('dinner');
  });

  it('returns bar for 21:00–05:59', () => {
    expect(classifyServicePeriod('2026-04-13T21:00:00')).toBe('bar');
    expect(classifyServicePeriod('2026-04-13T23:59:00')).toBe('bar');
    expect(classifyServicePeriod('2026-04-13T00:00:00')).toBe('bar');
    expect(classifyServicePeriod('2026-04-13T05:59:00')).toBe('bar');
  });
});

// ── sumMetric ────────────────────────────────────────────────────────────────

describe('sumMetric', () => {
  function makeChart(entries: { name: string; value: number | { quantity: number } }[]) {
    return {
      data: entries.map(e => ({
        metrics: [{ name: e.name, value: e.value }],
      })),
    };
  }

  it('sums numeric quantity values from all buckets', () => {
    const chart = makeChart([
      { name: 'GROSS_REVENUE', value: { quantity: 100.50 } },
      { name: 'GROSS_REVENUE', value: { quantity: 50.25 } },
      { name: 'GROSS_REVENUE', value: { quantity: 49.25 } },
    ]);
    expect(sumMetric(chart, 'GROSS_REVENUE')).toBe(200);
  });

  it('sums raw numeric values', () => {
    const chart = makeChart([
      { name: 'ORDERS', value: 5 },
      { name: 'ORDERS', value: 3 },
    ]);
    expect(sumMetric(chart, 'ORDERS')).toBe(8);
  });

  it('ignores metrics with a different name', () => {
    const chart = makeChart([
      { name: 'GROSS_REVENUE', value: { quantity: 100 } },
      { name: 'NET_REVENUE', value: { quantity: 80 } },
    ]);
    expect(sumMetric(chart, 'GROSS_REVENUE')).toBe(100);
    expect(sumMetric(chart, 'NET_REVENUE')).toBe(80);
  });

  it('returns null for null/undefined/empty chart data', () => {
    expect(sumMetric(null, 'GROSS_REVENUE')).toBeNull();
    expect(sumMetric(undefined, 'GROSS_REVENUE')).toBeNull();
    expect(sumMetric({}, 'GROSS_REVENUE')).toBeNull();
    expect(sumMetric({ data: [] }, 'GROSS_REVENUE')).toBe(0);
  });
});

// ── formatProductRevenue ─────────────────────────────────────────────────────

const PROFIT_CENTERS_FIXTURE = {
  all:      '00000000-0000-0000-0000-000000000000',
  west:     'aaaa-west',
  centraal: 'bbbb-centraal',
  testtafel: null,
};

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: '2026-04-13T13:00:00',
    profitCenterId: 'aaaa-west',
    items: [
      {
        productName: 'Soep van de dag',
        productGroup: 'Warme gerechten',
        quantity: 2,
        totalGross: 9.80,
        totalNet: 8.00,
      },
    ],
    ...overrides,
  };
}

describe('formatProductRevenue', () => {
  it('maps profit center UUID to location name', () => {
    const invoices = { content: [makeInvoice()] };
    const rows = formatProductRevenue(invoices, PROFIT_CENTERS_FIXTURE);
    expect(rows).toHaveLength(1);
    expect(rows[0].location).toBe('west');
    expect(rows[0].productName).toBe('Soep van de dag');
    expect(rows[0].productCategory).toBe('Warme gerechten');
    expect(rows[0].quantity).toBe(2);
    expect(rows[0].grossRevenue).toBe(9.80);
    expect(rows[0].netRevenue).toBe(8.00);
  });

  it('assigns correct meal period from timestamp', () => {
    const invoices = { content: [makeInvoice({ createdAt: '2026-04-13T13:00:00' })] };
    const rows = formatProductRevenue(invoices, PROFIT_CENTERS_FIXTURE);
    expect(rows[0].meal).toBe('lunch');
  });

  it('uses forceLocation when provided, ignoring profit center', () => {
    const invoices = { content: [makeInvoice({ profitCenterId: 'unknown-uuid' })] };
    const rows = formatProductRevenue(invoices, PROFIT_CENTERS_FIXTURE, { forceLocation: 'west' });
    expect(rows[0].location).toBe('west');
  });

  it('falls back to unknown for unrecognised profit center', () => {
    const invoices = { content: [makeInvoice({ profitCenterId: 'zzz-unknown' })] };
    const rows = formatProductRevenue(invoices, PROFIT_CENTERS_FIXTURE);
    expect(rows[0].location).toBe('unknown');
  });

  it('aggregates multiple items with the same key', () => {
    const invoices = {
      content: [
        makeInvoice(),
        makeInvoice({ items: [{ productName: 'Soep van de dag', productGroup: 'Warme gerechten', quantity: 1, totalGross: 4.90, totalNet: 4.00 }] }),
      ],
    };
    const rows = formatProductRevenue(invoices, PROFIT_CENTERS_FIXTURE);
    expect(rows).toHaveLength(1); // same key → merged
    expect(rows[0].quantity).toBe(3);
    expect(rows[0].grossRevenue).toBeCloseTo(14.70, 2);
    expect(rows[0].netRevenue).toBeCloseTo(12.00, 2);
  });

  it('records invoice total as fallback when invoice has no line items', () => {
    const invoices = {
      content: [
        { createdAt: '2026-04-13T19:00:00', profitCenterId: 'aaaa-west', items: [], totalGross: 15.00, totalNet: 12.30 },
      ],
    };
    const rows = formatProductRevenue(invoices, PROFIT_CENTERS_FIXTURE);
    expect(rows).toHaveLength(1);
    expect(rows[0].productName).toBe('Invoice Total');
    expect(rows[0].grossRevenue).toBe(15.00);
  });

  it('returns empty array for null/missing invoices', () => {
    expect(formatProductRevenue(null, PROFIT_CENTERS_FIXTURE)).toEqual([]);
    expect(formatProductRevenue({ content: [] }, PROFIT_CENTERS_FIXTURE)).toEqual([]);
  });
});

// ── formatResults ────────────────────────────────────────────────────────────

describe('formatResults', () => {
  function makeChartData(metricName: string, value: number) {
    return { data: [{ metrics: [{ name: metricName, value: { quantity: value } }] }] };
  }

  it('extracts top-level overview metrics', () => {
    const rawData = {
      revenue_overview_chart: makeChartData('GROSS_REVENUE', 500),
      orders_chart: makeChartData('ORDERS', 42),
      number_of_sales_chart: makeChartData('NUMBER_OF_SALES', 38),
      covers_count_chart: makeChartData('COVERS_COUNT', 120),
    };
    const summary = formatResults(rawData, '2026-04-13', PROFIT_CENTERS_FIXTURE);
    expect(summary.grossRevenue).toBe(500);
    expect(summary.orders).toBe(42);
    expect(summary.sales).toBe(38);
    expect(summary.covers).toBe(120);
  });

  it('extracts per-location revenue from profit center chart data', () => {
    const rawData = {
      revenue_overview_chart: makeChartData('GROSS_REVENUE', 300),
      revenue_west: makeChartData('GROSS_REVENUE', 200),
      revenue_centraal: makeChartData('GROSS_REVENUE', 100),
    };
    const summary = formatResults(rawData, '2026-04-13', PROFIT_CENTERS_FIXTURE);
    expect(summary.locations.west.grossRevenue).toBe(200);
    expect(summary.locations.centraal.grossRevenue).toBe(100);
  });

  it('extracts invoice count from pagination', () => {
    const rawData = {
      revenue_overview_chart: makeChartData('GROSS_REVENUE', 0),
      invoices: { pagination: { totalResults: 17 } },
    };
    const summary = formatResults(rawData, '2026-04-13', PROFIT_CENTERS_FIXTURE);
    expect(summary.invoiceCount).toBe(17);
  });
});

// ── Finance Sync API ─────────────────────────────────────────────────────────

describe('Finance Sync API', () => {
  it('GET /api/finance/sync-status — returns expected shape', async () => {
    const res = await request(app).get('/api/finance/sync-status');
    expect(res.status).toBe(200);
    expect(typeof res.body.syncing).toBe('boolean');
    expect(res.body).toHaveProperty('lastSyncAt');
    expect(res.body).toHaveProperty('lastSyncError');
    expect(typeof res.body.tebiConfigured).toBe('boolean');
  });

  it('POST /api/finance/sync — 500 when TEBI credentials not configured', async () => {
    // In the test environment TEBI_EMAIL/TEBI_PASSWORD are not set
    const savedEmail = process.env.TEBI_EMAIL;
    const savedPass  = process.env.TEBI_PASSWORD;
    delete process.env.TEBI_EMAIL;
    delete process.env.TEBI_PASSWORD;

    const res = await request(app)
      .post('/api/finance/sync')
      .send({});

    process.env.TEBI_EMAIL    = savedEmail;
    process.env.TEBI_PASSWORD = savedPass;

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/TEBI_EMAIL/i);
  });

  it('POST /api/finance/sync-cancel — returns cancelled even when not syncing', async () => {
    const res = await request(app).post('/api/finance/sync-cancel');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });
});
