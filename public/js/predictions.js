// ── PREDICTIONS — CSV parsing, Tebi categorization, guest prediction ────────

// ── CSV Parser ──────────────────────────────────────────────────────────────
// Turns raw CSV text into an array of objects (one per row), using column
// headers as keys. Handles quoted fields that contain commas (e.g. dates
// like "3/16/26, 10:13 AM") and escaped double-quotes.

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];

  function splitLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current); current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  const headers = splitLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = (vals[j] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

// ── Tebi Categorizer ────────────────────────────────────────────────────────
// Takes parsed CSV rows and figures out:
//   1. Which register (device) belongs to which location
//   2. How many meals were served per day per location per meal type
//
// The key insight: each sale has an Invoice ID like "723192|2026-03-16T09:13:39Z|INVOICE|3053680566|81"
// where the 4th part (3053680566) is the device/register ID. Devices that have
// sold "Dinner donation" are West registers; devices that sold "DSC Dinner" are Centraal.
// This lets us correctly assign ambiguous products like "Lunch" and "Staff & volunteer meals".

function categorizeTebiData(allRows, existingDeviceMap) {
  const deviceMap = { ...(existingDeviceMap || {}) };

  // Products that tell us a device's location (unambiguous markers)
  const WEST_MARKERS = ['Dinner donation', 'Stadspas Dinner'];
  const CENTRAAL_MARKERS = ['DSC Dinner'];

  // Products we count as meals, and what type they are
  const MEAL_PRODUCTS = {
    'Lunch':                     'lunch',
    'Lunch card guest':          'lunch',
    'Dinner donation':           'dinner',
    'Stadspas Dinner':           'dinner',
    'DSC Dinner':                'dinner',
    'Staff & volunteer meals':   'staff'
  };

  // Products where the location is always known from the name itself
  const FIXED_LOCATION = {
    'Dinner donation':  'west',
    'Stadspas Dinner':  'west',
    'DSC Dinner':       'centraal'
  };

  // Step 1: scan all rows to build device → location map
  for (const row of allRows) {
    const deviceId = extractDeviceId(row['Invoice ID']);
    if (!deviceId) continue;
    const name = row['Product name'];
    if (WEST_MARKERS.includes(name)) deviceMap[deviceId] = 'west';
    if (CENTRAAL_MARKERS.includes(name)) deviceMap[deviceId] = 'centraal';
  }

  // Step 2: count meals per day per location per type
  const aggregated = {
    west: { lunch: {}, dinner: {}, staff: {} },
    centraal: { lunch: {}, dinner: {}, staff: {} }
  };
  let totalMealRows = 0;
  let unmappedRows = 0;

  for (const row of allRows) {
    const name = row['Product name'];
    const mealType = MEAL_PRODUCTS[name];
    if (!mealType) continue; // not a meal product, skip (coffee, drinks, etc.)
    if (name === 'Lunch card') continue; // buying a card, not eating a meal

    const qty = parseInt(row['Quantity']) || 0;
    if (qty <= 0) continue; // skip refunds/negatives
    const date = row['Business day']; // format: "2026-03-16"
    if (!date) continue;

    // Determine location: fixed from product name, or from device
    let loc = FIXED_LOCATION[name];
    if (!loc) {
      const deviceId = extractDeviceId(row['Invoice ID']);
      loc = deviceMap[deviceId];
    }
    if (!loc) { unmappedRows++; continue; }

    totalMealRows++;
    aggregated[loc][mealType][date] = (aggregated[loc][mealType][date] || 0) + qty;
  }

  // Compute stats for the UI summary
  const allDates = new Set();
  for (const loc of ['west', 'centraal']) {
    for (const meal of ['lunch', 'dinner', 'staff']) {
      Object.keys(aggregated[loc][meal]).forEach(d => allDates.add(d));
    }
  }
  const sortedDates = [...allDates].sort();

  return {
    aggregated,
    deviceMap,
    stats: {
      totalRows: allRows.length,
      totalMealRows,
      unmappedRows,
      dateRange: sortedDates.length
        ? { from: sortedDates[0], to: sortedDates[sortedDates.length - 1] }
        : null,
      daysCount: sortedDates.length,
      perCategory: {
        westLunch: Object.keys(aggregated.west.lunch).length,
        westDinner: Object.keys(aggregated.west.dinner).length,
        westStaff: Object.keys(aggregated.west.staff).length,
        centraalLunch: Object.keys(aggregated.centraal.lunch).length,
        centraalDinner: Object.keys(aggregated.centraal.dinner).length,
        centraalStaff: Object.keys(aggregated.centraal.staff).length,
      }
    }
  };
}

// Pull the device ID out of an Invoice ID string
// Format: "723192|2026-03-16T09:13:39Z|INVOICE|3053680566|81"
//                                               ^^^^^^^^^^
function extractDeviceId(invoiceId) {
  if (!invoiceId) return null;
  const parts = invoiceId.split('|');
  return parts.length >= 4 ? parts[3] : null;
}

// ── Prediction Engine ───────────────────────────────────────────────────────
// Takes historical guest counts and predicts next week's numbers.
//
// For each location (West/Centraal) and meal (lunch/dinner), it:
//   1. Groups all counts by day-of-week (all Mondays, all Tuesdays, etc.)
//   2. Winsorizes outliers — caps extreme values to a reasonable range
//      (so a huge event day of 300 when normal is ~100 gets capped to ~170,
//       reducing its pull on the average without throwing it away entirely)
//   3. Calculates a weighted average giving more importance to recent weeks
//   4. Detects trends (growing or shrinking guest numbers) and adjusts

function predictGuests(history) {
  const predictions = {};
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  for (const loc of ['west', 'centraal']) {
    predictions[loc] = {};
    for (const day of DAY_NAMES) {
      predictions[loc][day] = {};
    }

    for (const meal of ['lunch', 'dinner']) {
      const dateMap = (history[loc] && history[loc][meal]) || {};
      const entries = Object.entries(dateMap)
        .map(([date, count]) => ({ date, count, dow: getDayOfWeek(date) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Group by day of week
      const byDow = {};
      for (const day of DAY_NAMES) byDow[day] = [];
      for (const e of entries) {
        if (byDow[e.dow]) byDow[e.dow].push(e);
      }

      for (const day of DAY_NAMES) {
        const values = byDow[day];
        if (values.length === 0) {
          predictions[loc][day][meal] = 0;
          continue;
        }

        // Winsorize: cap outliers to IQR boundaries
        const counts = values.map(v => v.count);
        const winsorized = winsorize(counts);

        // Apply recency weights: most recent = 1.0, each week back × 0.9
        const decay = 0.9;
        let weightedSum = 0;
        let weightTotal = 0;
        for (let i = 0; i < winsorized.length; i++) {
          const weeksBack = winsorized.length - 1 - i; // 0 = oldest, last = newest
          const weight = Math.pow(decay, weeksBack);
          weightedSum += winsorized[i] * weight;
          weightTotal += weight;
        }
        let prediction = weightTotal > 0 ? weightedSum / weightTotal : 0;

        // Trend adjustment: compare first half to second half
        if (winsorized.length >= 4) {
          const mid = Math.floor(winsorized.length / 2);
          const firstHalf = winsorized.slice(0, mid);
          const secondHalf = winsorized.slice(mid);
          const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
          const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
          if (avgFirst > 0) {
            const changePct = (avgSecond - avgFirst) / avgFirst;
            // Only adjust if trend is meaningful (>5% change)
            if (Math.abs(changePct) > 0.05) {
              prediction += (avgSecond - avgFirst) * 0.5;
            }
          }
        }

        predictions[loc][day][meal] = Math.max(0, Math.round(prediction));
      }
    }
  }
  return predictions;
}

// Winsorize an array: cap values beyond Q1 - 1.5*IQR and Q3 + 1.5*IQR
// to the boundary value. This reduces the influence of extreme outliers
// (like big event days) proportionally — the more extreme, the more it's
// pulled back — without throwing the data point away entirely.
function winsorize(values) {
  if (values.length < 4) return [...values]; // too few points to meaningfully winsorize
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  return values.map(v => Math.min(Math.max(v, lower), upper));
}

// Calculate a percentile from a sorted array
function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Convert a "YYYY-MM-DD" date string to a day name ("Mon", "Tue", etc.)
function getDayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00'); // noon to avoid timezone edge cases
  const jsDay = d.getDay(); // 0=Sun, 1=Mon, ...
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return DAY_NAMES[jsDay];
}
