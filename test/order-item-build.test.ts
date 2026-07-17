/**
 * buildOrderItem / hasHanosCode (public/js/orders.ts) — the pure logic behind
 * "include uncoded items on the Excel order sheet but not in the Hanos cart".
 *
 * DOM stubs come from test/setup-dom-stubs.ts (jest setupFiles).
 */
import { buildOrderItem, hasHanosCode } from '../public/js/orders';

const coded = { name: 'Olive oil', orderCode: 'H123', orderUnit: 'can', orderPrice: 24.5, orderUnitSize: 5000, unit: 'ml' };
const codedNoUnit = { name: 'Saffron', orderCode: 'H999', orderUnitSize: 0, unit: 'g' };
const urlCode = { name: 'Special sauce', orderCode: 'https://shop/x', orderUnitSize: 0, unit: 'ml' };
const uncoded = { name: 'Garden herbs', orderCode: '', orderUnitSize: 0, unit: 'g' };

describe('hasHanosCode', () => {
  it('true only for a real code (not empty, not a URL)', () => {
    expect(hasHanosCode(coded)).toBe(true);
    expect(hasHanosCode(uncoded)).toBe(false);
    expect(hasHanosCode(urlCode)).toBe(false);
    expect(hasHanosCode(null)).toBe(false);
  });
});

describe('buildOrderItem', () => {
  it('coded + order unit → order-unit quantity, code, and price (cart shape)', () => {
    const it = buildOrderItem(coded, 12000, false)!; // 12L to order, 5L cans → ceil(2.4)=3
    expect(it).toMatchObject({ name: 'Olive oil', orderCode: 'H123', quantity: 3, unit: 'ST', unitLabel: 'can', price: 24.5 });
  });

  it('cart path (includeUncoded=false) drops an uncoded item entirely', () => {
    expect(buildOrderItem(uncoded, 500, false)).toBeNull();
    expect(buildOrderItem(urlCode, 500, false)).toBeNull();
  });

  it('cart path drops a coded item that has no order unit (unchanged legacy behavior)', () => {
    expect(buildOrderItem(codedNoUnit, 20, false)).toBeNull();
  });

  it('Excel path (includeUncoded=true) includes an uncoded item in base units, no code, no price', () => {
    const it = buildOrderItem(uncoded, 2000, true)!; // 2000g → 2 kg
    expect(it).toMatchObject({ name: 'Garden herbs', orderCode: '', quantity: 2, unitLabel: 'kg', price: 0 });
  });

  it('Excel path keeps a URL-coded item but blanks the code (a URL is not a code)', () => {
    const it = buildOrderItem(urlCode, 1500, true)!; // 1500ml → 1.5 L
    expect(it).toMatchObject({ name: 'Special sauce', orderCode: '', quantity: 1.5, unitLabel: 'L', price: 0 });
  });

  it('Excel path still prefers order units + price for a coded item', () => {
    const it = buildOrderItem(coded, 12000, true)!;
    expect(it).toMatchObject({ orderCode: 'H123', quantity: 3, unitLabel: 'can', price: 24.5 });
  });

  it('nothing to order → null on both paths', () => {
    expect(buildOrderItem(coded, 0, false)).toBeNull();
    expect(buildOrderItem(uncoded, 0, true)).toBeNull();
  });
});
