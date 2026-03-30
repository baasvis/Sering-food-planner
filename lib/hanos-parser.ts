// Parse Hanos "hoeveelheid" field into grams/ml, e.g. "Pak 1 liter" → 1000
export function parseHanosQuantityGrams(hoeveelheid: string): number {
  if (!hoeveelheid) return 0;
  const s = hoeveelheid.toLowerCase();
  const numMatch = s.match(/([\d.,]+)\s*(kilo(?:gram)?|gram|liter|ml|stuk)/);
  if (!numMatch) return 0;
  const num = parseFloat(numMatch[1].replace(',', '.'));
  const unit = numMatch[2];
  if (unit.startsWith('kilo')) return num * 1000;
  if (unit === 'liter') return num * 1000;
  if (unit === 'gram') return num;
  if (unit === 'ml') return num;
  if (unit === 'stuk') return 0;
  return 0;
}
