import { test, expect, type Page } from '@playwright/test';
import { loginAsDev, deleteBatchesByNamePrefix } from './helpers';

/**
 * Event locations — full lifecycle (event-locations build, phase G).
 *
 * Drives the reusable temporary-location feature end to end as a director:
 *   create on the Team screen → planner tab appears → assign a batch to an
 *   event slot → enter guest counts → manual ship West→event → switch the
 *   global location → confirm arrival on the event dashboard → return the
 *   leftovers → archive → tab gone → hard-delete (cleanup).
 *
 * Serial: each step builds on the previous one's state.
 */

const RUN = `E2E Fest ${Date.now()}`;
const BATCH = `e2e-evloc-soup-${Date.now()}`;

// The immutable slug the server derives from RUN ("E2E Fest 17…" → "ev-e2e-fest-17…").
const slugOf = (name: string) => 'ev-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const SLUG = slugOf(RUN);

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function cleanup(page: Page): Promise<void> {
  // Batches with stock can't be DELETEd (real-food guard) — zero their
  // inventory/shipments first, then delete by prefix. Also strip any stray
  // reference to THIS run's slug from other batches (defence in depth: a
  // selector bug once shipped a real batch's food to the test event), so the
  // zero-reference DELETE below always succeeds.
  await page.evaluate(async ({ prefix, slug }) => {
    const res = await fetch('/api/batches');
    if (!res.ok) return;
    type B = { id: string; name: string; inventory?: Array<{ loc: string }>; shipments?: Array<{ toLoc: string; fromLoc: string }>; services?: Array<{ loc: string }> };
    const all = (await res.json()) as B[];
    for (const b of all) {
      if (b.name && b.name.startsWith(prefix)) {
        await fetch(`/api/batches/${b.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inventory: [], shipments: [], services: [] }),
        }).catch(() => null);
        continue;
      }
      const touches = (b.inventory || []).some(e => e.loc === slug)
        || (b.shipments || []).some(s => s.toLoc === slug || s.fromLoc === slug)
        || (b.services || []).some(s => s.loc === slug);
      if (touches) {
        await fetch(`/api/batches/${b.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inventory: (b.inventory || []).filter(e => e.loc !== slug),
            shipments: (b.shipments || []).filter(s => s.toLoc !== slug && s.fromLoc !== slug),
            services: (b.services || []).filter(s => s.loc !== slug),
          }),
        }).catch(() => null);
      }
    }
  }, { prefix: 'e2e-evloc-', slug: SLUG });
  await deleteBatchesByNamePrefix(page, 'e2e-evloc-');
  // Hard-delete the event location (archived + unreferenced only). Both the
  // archive and delete are best-effort — a mid-flow failure leaves at worst
  // an archived row named "E2E Fest …".
  await page.evaluate(async (slug) => {
    await fetch(`/api/event-locations/${slug}/archive`, { method: 'POST' }).catch(() => null);
    await fetch(`/api/event-locations/${slug}`, { method: 'DELETE' }).catch(() => null);
  }, SLUG);
}

// Every step round-trips the remote staging DB and several tests chain many
// UI actions — give the serial suite headroom over the 30s default.
test.describe.configure({ timeout: 60_000 });

test.describe.serial('event location lifecycle', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await loginAsDev(page);
  });

  test.afterAll(async () => {
    await cleanup(page);
    await page.close();
  });

  test('director creates an event location on the Team screen', async () => {
    await page.locator('.nav-btn[data-screen="team"]').click();
    await page.getByTestId('evloc-new-btn').click();

    const today = new Date();
    const end = new Date(today);
    end.setDate(today.getDate() + 9);
    await page.locator('#evloc-name').fill(RUN);
    await page.locator('#evloc-start').fill(iso(today));
    await page.locator('#evloc-end').fill(iso(end));
    const created = page.waitForResponse(r => r.url().includes('/api/event-locations') && r.request().method() === 'POST');
    await page.getByTestId('evloc-create-confirm').click();
    expect((await created).status()).toBe(201);

    // The Team card lists it as active.
    await expect(page.locator(`.team-row[data-evloc="${SLUG}"]`)).toBeVisible();
  });

  test('the planner grows a tab for the event', async () => {
    await page.locator('.nav-btn[data-screen="planner"]').click();
    const tab = page.locator(`.sub-tab[data-tab="${SLUG}"]`);
    await expect(tab).toBeVisible();
    await tab.click();
    // Event tabs carry the manual-transport shortcuts; West-only controls don't render.
    await expect(page.getByTestId('event-ship-btn')).toBeVisible();
    await expect(page.locator('.btn-fix-menu')).toHaveCount(0);
  });

  test('a West-cooked batch can be assigned to an event slot', async () => {
    // Seed a cooked batch with West stock via the API (batch creation UI is
    // covered by batch-create.spec.ts — this spec is about the event flows).
    const res = await page.evaluate(async (name) => {
      const today = new Date();
      const cook = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
      const r = await fetch('/api/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `e2e-evloc-${Date.now()}`, name, type: 'Soup', serving: 280, cookDate: cook,
          inventory: [{ loc: 'west', storage: 'Gastro', qty: 40, cookDate: cook }],
          shipments: [], services: [],
        }),
      });
      return r.status;
    }, BATCH);
    expect(res).toBe(201);

    // The page's own fetch bypasses the app state layer (and SSE never echoes
    // to the sender), so S.batches doesn't know the new batch — reload so
    // loadData picks it up, then open the event tab.
    const dataLoaded = page.waitForResponse(r => r.url().endsWith('/api/data') && r.request().method() === 'GET');
    await page.reload();
    await dataLoaded;
    await page.locator('.nav-btn[data-screen="planner"]').click();
    await page.locator(`.sub-tab[data-tab="${SLUG}"]`).click();

    const slots = page.locator('.slot[data-meal="dinner"][data-type="Soup"]');
    await slots.nth(1).locator('.add-slot-btn').click(); // tomorrow's dinner
    // The modal opens filtered to the event location (no stock there yet) —
    // flip the location filter to West where the batch's stock lives.
    await page.locator('#add-modal-loc-toggle .order-loc-btn.loc-west').click();
    await page.locator('.dish-opt', { hasText: BATCH }).first().click();
    await expect(page.locator('.dish-chip', { hasText: BATCH }).first()).toBeVisible();
  });

  test('Fix My Menu leaves the festival assignment alone', async () => {
    // The headline invariant, full-stack: run FMM on West, then confirm the
    // hand-planned event chip is still there (event services are spared like
    // pins — unit tests pin the functions, this pins the wiring).
    await page.locator('.sub-tab[data-tab="west"]').click();
    // fixMyMenu() opens a NATIVE confirm() first — Playwright auto-dismisses
    // native dialogs (returns false), which silently aborts the run.
    page.once('dialog', d => void d.accept());
    await page.locator('.btn-fix-menu').click();
    // FMM ends with a results modal — wait for it, then dismiss.
    await expect(page.locator('#modal-root .modal')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await page.locator(`.sub-tab[data-tab="${SLUG}"]`).click();
    await expect(page.locator('.dish-chip', { hasText: BATCH }).first()).toBeVisible();
  });

  test('an ingredient stocktake at the event writes the event key', async () => {
    // Stocktake flows are loc-parameterized — verify an on-site count lands
    // under the event's own stock key, not west's.
    const result = await page.evaluate(async (slug) => {
      const list = await (await fetch('/api/ingredients')).json();
      const ing = Array.isArray(list) && list[0];
      if (!ing) return { skipped: true };
      const r = await fetch('/api/ingredients/stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingredientId: ing.id, location: slug, amount: 7 }),
      });
      if (!r.ok) return { status: r.status };
      const fresh = await (await fetch('/api/ingredients')).json();
      const mine = fresh.find((x: { id: string }) => x.id === ing.id);
      // Restore west/centraal untouched; zero our key again for cleanup.
      await fetch('/api/ingredients/stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingredientId: ing.id, location: slug, amount: 0 }),
      });
      return { status: r.status, amount: mine?.stock?.[slug]?.amount, west: mine?.stock?.west?.amount };
    }, SLUG);
    if (!('skipped' in result)) {
      expect(result.status).toBe(200);
      expect(result.amount).toBe(7);
    }
  });

  test('guest counts for the event are edited on their own card', async () => {
    await page.locator('.nav-btn[data-screen="guests"]').click();
    const card = page.locator('.guests-loc-card.loc-event', { hasText: RUN });
    await expect(card).toBeVisible();
    const input = card.locator('.gt-input:not([disabled])').first();
    await input.fill('400');
    await input.dispatchEvent('change');
    // The card's week total reflects the entry.
    await expect(card).toContainText('400');
  });

  test('manual ship West → event, then confirm arrival on the event dashboard', async () => {
    await page.locator('.nav-btn[data-screen="planner"]').click();
    await page.locator(`.sub-tab[data-tab="${SLUG}"]`).click();
    await page.getByTestId('event-ship-btn').click();
    // Target OUR batch's row by name — the modal lists every cooked batch
    // with West stock, and filling .first() once shipped a REAL staging
    // batch's food to the test event.
    const qty = page.locator('.pack-edit-row', { hasText: BATCH }).locator('[data-manual-ship]');
    await expect(qty).toBeVisible();
    await qty.fill('5');
    const shipped = page.waitForResponse(r => r.url().includes('/ship') && r.request().method() === 'POST');
    await page.getByTestId('manual-ship-confirm').click();
    expect((await shipped).status()).toBe(200);

    // Transport tab lists the pending shipment.
    await page.locator('.sub-tab[data-tab="transport"]').click();
    await expect(page.locator('.ship-row', { hasText: '5.0L' }).first()).toBeVisible();

    // Switch the whole app to the event via the top-bar picker…
    await page.locator('#app-title').click();
    await page.getByTestId(`loc-pick-${SLUG}`).click();
    // …and confirm the arrival from the red dashboard block.
    await page.locator('.nav-btn[data-screen="dashboard"]').click();
    const block = page.locator('.dash-arrival-block');
    await expect(block).toBeVisible();
    const arrived = page.waitForResponse(r => r.url().includes('/arrived') && r.request().method() === 'POST');
    await block.click();
    expect((await arrived).status()).toBe(200);
    await expect(block).toHaveCount(0);
  });

  test('leftovers return to West and the event is archived', async () => {
    // Return the 5L from the event back to West.
    await page.locator('.nav-btn[data-screen="planner"]').click();
    await page.locator(`.sub-tab[data-tab="${SLUG}"]`).click();
    await page.getByTestId('event-return-btn').click();
    const qty = page.locator('.pack-edit-row', { hasText: BATCH }).locator('[data-manual-ship]');
    await expect(qty).toBeVisible();
    await qty.fill('5');
    await page.getByTestId('manual-ship-confirm').click();
    // West confirms the return via the Transport tab's PER-ROW button — the
    // dashboard block confirms EVERY pending west-bound shipment at once,
    // which on the shared staging DB would mutate unrelated batches.
    await page.locator('#app-title').click();
    await page.getByTestId('loc-pick-west').click();
    await page.locator('.nav-btn[data-screen="planner"]').click();
    await page.locator('.sub-tab[data-tab="transport"]').click();
    const card = page.locator('.ship-batch-card', { hasText: BATCH });
    await expect(card).toBeVisible();
    const returned = page.waitForResponse(r => r.url().includes('/arrived') && r.request().method() === 'POST');
    await card.locator('.ship-row button', { hasText: 'Mark arrived' }).first().click();
    expect((await returned).status()).toBe(200);
    await expect(page.locator('.ship-batch-card', { hasText: BATCH })).toHaveCount(0);

    // Archive from the Team screen (soft warnings modal → confirm).
    await page.locator('.nav-btn[data-screen="team"]').click();
    await page.locator(`.team-row[data-evloc="${SLUG}"]`).getByTestId('evloc-archive-btn').click();
    const archived = page.waitForResponse(r => r.url().includes('/archive') && r.request().method() === 'POST');
    await page.getByTestId('evloc-archive-confirm').click();
    expect((await archived).status()).toBe(200);

    // The planner tab is gone; west/centraal remain.
    await page.locator('.nav-btn[data-screen="planner"]').click();
    await expect(page.locator(`.sub-tab[data-tab="${SLUG}"]`)).toHaveCount(0);
    await expect(page.locator('.sub-tab[data-tab="west"]')).toBeVisible();
  });
});
