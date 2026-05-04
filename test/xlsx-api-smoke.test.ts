/**
 * D2 — `xlsx` 0.18.5 (the High-CVE version) was swapped for the
 * CDN-hosted 0.20.3. Confirm the two API entry points the project actually
 * uses (`XLSX.read(buffer)` and `XLSX.utils.sheet_to_json`) still work
 * with the new build. Single round-trip is enough — if the API ever drifts
 * we want a fast-failing test instead of a runtime crash on the next
 * supplier upload.
 *
 * Stays in its own file so it doesn't pull in app/prisma — these tests
 * exercise the library only.
 */

import XLSX from 'xlsx';

describe('xlsx (D2 — CDN 0.20.3)', () => {
  it('XLSX.read + sheet_to_json round-trip', () => {
    const data = [
      ['header-a', 'header-b'],
      ['row1-a', 'row1-b'],
      ['row2-a', 'row2-b'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'prices');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    expect(Buffer.isBuffer(buf)).toBe(true);

    const reread = XLSX.read(buf, { type: 'buffer' });
    expect(reread.SheetNames).toEqual(['prices']);
    const parsed = XLSX.utils.sheet_to_json(reread.Sheets['prices'], { header: 1 });
    expect(parsed).toEqual(data);
  });
});
