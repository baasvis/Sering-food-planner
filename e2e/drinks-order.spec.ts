import { test, expect } from '@playwright/test';
import { loginAsDev, deleteDrinksByNamePrefix } from './helpers';

const PREFIX = 'e2e-orddrink-';

test.describe('Drinks orders', () => {
  test.afterEach(async ({ page }) => {
    await deleteDrinksByNamePrefix(page, PREFIX);
  });

  test('a short drink is listed under its supplier, ordered, then received', async ({ page }) => {
    await loginAsDev(page);

    // Seed a catalogue drink that is guaranteed short at West (par 5, no stock)
    // under its own supplier, so the Orders shortfall view is deterministic
    // regardless of how seed stock has drifted on the shared test DB.
    const name = `${PREFIX}${Date.now()}`;
    const supplier = `${PREFIX}sup-${Date.now()}`;
    await page.evaluate(async ({ name, supplier }) => {
      await fetch('/api/drinks', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: name, mode: 'catalogue', name, category: 'beer', subtype: '', abv: 5, btwRate: null,
          status: 'draft', sellable: true, supplier, orderUnit: 'crate', orderUnitMl: null, packNote: '',
          itemId: null, deposit: 0, costPrice: 10, costNote: '', formats: [],
          locations: { west: { par: 5, active: true } }, info: {}, tebiProductNames: [],
        }),
      });
    }, { name, supplier });
    await page.reload();

    await page.locator('.nav-btn[data-screen="drinks"]').click();
    await page.getByTestId('drinks-tab-orders').click();

    // The Orders tab auto-lists what's short, grouped per supplier (no "+new order").
    const section = page.locator(`[data-testid="ord-shortfall"][data-supplier="${supplier}"]`);
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section.locator('.sf-qty').first()).toBeVisible();

    // Place the order straight from the shortfall list (creates + marks ordered).
    const createResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/drinks/orders') && r.request().method() === 'POST', { timeout: 10_000 });
    await section.getByTestId('ord-place').click();
    const created = await createResp;
    expect(created.ok()).toBe(true);
    const order = await created.json();

    // It lands in "Open orders" with a Receive action.
    const card = page.locator(`[data-testid="drink-order-card"][data-id="${order.id}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Receive it (qty 0 — lifecycle only, no stock drift on the shared DB).
    await card.getByTestId('drink-order-receive').click();
    await expect(page.getByTestId('drink-order-receive-form')).toBeVisible();
    const qtyInputs = page.locator('.rcv-qty');
    const n = await qtyInputs.count();
    for (let i = 0; i < n; i++) await qtyInputs.nth(i).fill('0');

    const recvResp = page.waitForResponse(
      (r) => r.url().includes(`/api/drinks/orders/${order.id}`) && r.request().method() === 'PATCH', { timeout: 10_000 });
    await page.getByTestId('drink-order-receive-confirm').click();
    const recv = await recvResp;
    expect(recv.ok()).toBe(true);
    expect((await recv.json()).status).toBe('received');
  });
});
