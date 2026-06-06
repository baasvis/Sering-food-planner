import { test, expect } from '@playwright/test';
import { loginAsDev } from './helpers';

test.describe('Drinks orders', () => {
  test('create a draft order, mark ordered, then receive', async ({ page }) => {
    await loginAsDev(page);
    await page.locator('.nav-btn[data-screen="drinks"]').click();
    await page.getByTestId('drinks-tab-orders').click();

    // New order for a supplier with par-deficient seed stock (Two Chefs: pilsner par 16 / stock 5).
    await page.getByTestId('drink-order-new').click();
    await page.locator('#ord-supplier').selectOption({ label: 'Two Chefs Brewing' });
    await expect(page.locator('.ord-qty').first()).toBeVisible({ timeout: 10_000 });

    const createResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/drinks/orders') && r.request().method() === 'POST', { timeout: 10_000 });
    await page.getByTestId('drink-order-create').click();
    const created = await createResp;
    expect(created.ok()).toBe(true);
    const order = await created.json();
    expect(order.status).toBe('draft');

    // The new draft card shows with a "Mark ordered" action.
    const card = page.locator(`[data-testid="drink-order-card"][data-id="${order.id}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Mark ordered.
    const orderedResp = page.waitForResponse(
      (r) => r.url().includes(`/api/drinks/orders/${order.id}`) && r.request().method() === 'PATCH', { timeout: 10_000 });
    await card.locator('button:has-text("Mark ordered")').click();
    expect((await orderedResp).ok()).toBe(true);

    // Receive — set received quantities to 0 (lifecycle only; no staging stock drift).
    await page.locator(`[data-testid="drink-order-card"][data-id="${order.id}"] [data-testid="drink-order-receive"]`).click();
    await expect(page.getByTestId('drink-order-receive-form')).toBeVisible();
    const qtyInputs = page.locator('.rcv-qty');
    const n = await qtyInputs.count();
    for (let i = 0; i < n; i++) await qtyInputs.nth(i).fill('0');

    const recvResp = page.waitForResponse(
      (r) => r.url().includes(`/api/drinks/orders/${order.id}`) && r.request().method() === 'PATCH', { timeout: 10_000 });
    await page.getByTestId('drink-order-receive-confirm').click();
    const recv = await recvResp;
    expect(recv.ok()).toBe(true);
    const done = await recv.json();
    expect(done.status).toBe('received');
  });
});
