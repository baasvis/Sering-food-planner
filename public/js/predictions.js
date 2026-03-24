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

// ── Multi-Format File Processor ──────────────────────────────────────────────
// Auto-detects and processes three CSV formats:
//   1. Tebi ProductOrdersReport (comma-sep, has "Invoice ID" + "Business day")
//   2. Tebi ProductReportByProfitCenter (comma-sep, has "Profit Center" + "Items sold")
//   3. Lightspeed receipt-items (semicolon-sep, has "Company Name" + "Creation Date")

// Data model: lunch/dinner include staff. staff_lunch/staff_dinner track how
// many of those were staff (for display). When multiple sources have data for
// the same day, we average them (prevents double-counting from overlapping POS systems).

function emptyAggregated() {
  return {
    west: { lunch: {}, dinner: {}, staff_lunch: {}, staff_dinner: {} },
    centraal: { lunch: {}, dinner: {}, staff_lunch: {}, staff_dinner: {} }
  };
}
const AGG_MEALS = ['lunch', 'dinner', 'staff_lunch', 'staff_dinner'];

function categorizeUploadedFiles(fileContents, existingDeviceMap) {
  // Each source file gets its own layer — we average overlapping days at the end
  const layers = [];
  const allTimeEvents = [];
  const deviceMap = { ...(existingDeviceMap || {}) };
  let totalMealRows = 0;
  let unmappedRows = 0;
  let totalRows = 0;
  const formats = [];

  for (const { text, filename } of fileContents) {
    const format = detectFormat(text);
    formats.push(format);

    if (format === 'tebi-orders') {
      const rows = parseCSV(text);
      totalRows += rows.length;
      const result = categorizeTebiData(rows, deviceMap);
      layers.push(result.aggregated);
      allTimeEvents.push(...result.timeEvents);
      Object.assign(deviceMap, result.deviceMap);
      totalMealRows += result.stats.totalMealRows;
      unmappedRows += result.stats.unmappedRows;

    } else if (format === 'tebi-profitcenter') {
      const rows = parseCSV(text);
      totalRows += rows.length;
      const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : null;
      if (!date) { unmappedRows += rows.length; continue; }
      const result = categorizeProfitCenterData(rows, date);
      layers.push(result.aggregated);
      totalMealRows += result.totalMealRows;
      // ProfitCenter has no per-row timestamps — no timeEvents

    } else if (format === 'lightspeed') {
      const rows = parseSemicolonCSV(text);
      totalRows += rows.length;
      const result = categorizeLightspeedData(rows);
      layers.push(result.aggregated);
      allTimeEvents.push(...result.timeEvents);
      totalMealRows += result.totalMealRows;

    } else {
      unmappedRows += text.split('\n').length;
    }
  }

  // Merge layers: average when multiple sources have data for the same day/loc/meal
  const aggregated = averageLayers(layers);

  // Build normalized flow distributions from time events
  const flowDistribution = buildFlowDistribution(allTimeEvents);

  const allDates = new Set();
  for (const loc of ['west', 'centraal']) {
    for (const meal of AGG_MEALS) {
      Object.keys(aggregated[loc][meal]).forEach(d => allDates.add(d));
    }
  }
  const sortedDates = [...allDates].sort();

  return {
    aggregated,
    deviceMap,
    flowDistribution,
    stats: {
      totalRows,
      totalMealRows,
      unmappedRows,
      formats: [...new Set(formats)],
      dateRange: sortedDates.length
        ? { from: sortedDates[0], to: sortedDates[sortedDates.length - 1] }
        : null,
      daysCount: sortedDates.length,
      perCategory: {
        westLunch: Object.keys(aggregated.west.lunch).length,
        westDinner: Object.keys(aggregated.west.dinner).length,
        westStaff: Object.keys(aggregated.west.staff_lunch).length + Object.keys(aggregated.west.staff_dinner).length,
        centraalLunch: Object.keys(aggregated.centraal.lunch).length,
        centraalDinner: Object.keys(aggregated.centraal.dinner).length,
        centraalStaff: Object.keys(aggregated.centraal.staff_lunch).length + Object.keys(aggregated.centraal.staff_dinner).length,
      }
    }
  };
}

// ── Flow Distribution Builder ─────────────────────────────────────────────
// Takes an array of time events [{loc, meal, date, minuteOfDay}, ...] and
// builds normalized per-5-min distributions grouped by location, meal, and
// day-of-week. Each bucket value is a fraction of total guests for that group.

function buildFlowDistribution(timeEvents) {
  if (!timeEvents || timeEvents.length === 0) return null;

  // Only include events within actual service windows
  const SERVICE_WINDOWS = {
    lunch:  { start: 12 * 60, end: 14 * 60 },   // 12:00 — 14:00
    dinner: { start: 18 * 60, end: 21 * 60 },    // 18:00 — 21:00
  };

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Collect raw counts: loc → meal → dow → { bucket: count }
  const raw = {};

  for (const ev of timeEvents) {
    // Filter to service window
    const win = SERVICE_WINDOWS[ev.meal];
    if (!win || ev.minuteOfDay < win.start || ev.minuteOfDay >= win.end) continue;

    const bucket = Math.floor(ev.minuteOfDay / 5) * 5; // round down to 5-min
    const dow = DAY_NAMES[new Date(ev.date + 'T12:00:00').getDay()];

    if (!raw[ev.loc]) raw[ev.loc] = {};
    if (!raw[ev.loc][ev.meal]) raw[ev.loc][ev.meal] = {};
    if (!raw[ev.loc][ev.meal][dow]) raw[ev.loc][ev.meal][dow] = {};
    raw[ev.loc][ev.meal][dow][bucket] = (raw[ev.loc][ev.meal][dow][bucket] || 0) + 1;
  }

  // Normalize each group to fractions summing to 1.0
  const dist = {};
  for (const loc of Object.keys(raw)) {
    dist[loc] = {};
    for (const meal of Object.keys(raw[loc])) {
      dist[loc][meal] = {};
      for (const dow of Object.keys(raw[loc][meal])) {
        const buckets = raw[loc][meal][dow];
        const total = Object.values(buckets).reduce((s, v) => s + v, 0);
        if (total === 0) continue;
        dist[loc][meal][dow] = {};
        for (const [bucket, count] of Object.entries(buckets)) {
          dist[loc][meal][dow][bucket] = Math.round((count / total) * 10000) / 10000;
        }
      }
    }
  }
  return dist;
}

// Average overlapping data across layers. If two sources both have West lunch
// on March 18, take the average. If only one has it, use that value.
function averageLayers(layers) {
  const result = emptyAggregated();
  for (const loc of ['west', 'centraal']) {
    for (const meal of AGG_MEALS) {
      // Collect all dates and their values from each layer
      const dateValues = {}; // date → [val1, val2, ...]
      for (const layer of layers) {
        if (!layer[loc] || !layer[loc][meal]) continue;
        for (const [date, count] of Object.entries(layer[loc][meal])) {
          if (!dateValues[date]) dateValues[date] = [];
          dateValues[date].push(count);
        }
      }
      // Average
      for (const [date, values] of Object.entries(dateValues)) {
        result[loc][meal][date] = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      }
    }
  }
  return result;
}

// Detect file format from header line
function detectFormat(text) {
  const firstLine = text.split('\n')[0];
  if (firstLine.includes(';') && firstLine.includes('Company Name')) return 'lightspeed';
  if (firstLine.includes('Profit Center') && firstLine.includes('Items sold')) return 'tebi-profitcenter';
  if (firstLine.includes('Invoice ID') && firstLine.includes('Business day')) return 'tebi-orders';
  return 'unknown';
}

// Parse semicolon-separated CSV (Lightspeed format)
function parseSemicolonCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(';').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = lines[i].split(';');
    const row = {};
    headers.forEach((h, j) => { row[h] = (vals[j] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

// Merge source aggregated data into target (additive) — used for server-side history merging
function mergeAggregated(target, source) {
  for (const loc of ['west', 'centraal']) {
    if (!source[loc]) continue;
    for (const meal of AGG_MEALS) {
      if (!source[loc][meal]) continue;
      if (!target[loc][meal]) target[loc][meal] = {};
      for (const [date, count] of Object.entries(source[loc][meal])) {
        target[loc][meal][date] = (target[loc][meal][date] || 0) + count;
      }
    }
  }
}

// ── Tebi ProfitCenter Categorizer ───────────────────────────────────────────
// Much cleaner than ProductOrders: "Profit Center" column says "Sering West"
// or "Sering Centraal" directly. "Items sold" is already summed per product.
// Date must be provided from the filename since it's not in the CSV.

function categorizeProfitCenterData(rows, date) {
  const aggregated = emptyAggregated();
  // Staff meals are split by Time Dimension: Morning/Lunch/Afternoon = lunch staff, Dinner/Party = dinner staff
  const LUNCH_TIMES = ['Morning', 'Lunch', 'Afternoon'];
  let totalMealRows = 0;

  for (const row of rows) {
    const name = row['Name'];
    const qty = parseInt(row['Items sold']) || 0;
    if (qty <= 0) continue;

    const profitCenter = row['Profit Center'] || '';
    let loc = null;
    if (profitCenter.includes('West')) loc = 'west';
    else if (profitCenter.includes('Centraal')) loc = 'centraal';
    if (!loc) continue;

    const timeDim = row['Time Dimension'] || '';

    if (name === 'Lunch' || name === 'Lunch card guest') {
      totalMealRows += qty;
      aggregated[loc].lunch[date] = (aggregated[loc].lunch[date] || 0) + qty;
    } else if (name === 'Dinner donation' || name === 'Stadspas Dinner' || name === 'DSC Dinner') {
      totalMealRows += qty;
      aggregated[loc].dinner[date] = (aggregated[loc].dinner[date] || 0) + qty;
    } else if (name === 'Staff & volunteer meals') {
      totalMealRows += qty;
      if (LUNCH_TIMES.includes(timeDim)) {
        aggregated[loc].lunch[date] = (aggregated[loc].lunch[date] || 0) + qty;
        aggregated[loc].staff_lunch[date] = (aggregated[loc].staff_lunch[date] || 0) + qty;
      } else {
        aggregated[loc].dinner[date] = (aggregated[loc].dinner[date] || 0) + qty;
        aggregated[loc].staff_dinner[date] = (aggregated[loc].staff_dinner[date] || 0) + qty;
      }
    }
  }

  return { aggregated, totalMealRows };
}

// ── Lightspeed Categorizer ──────────────────────────────────────────────────
// Sering Centraal lunches from the Lightspeed (TestTafel) system.
// Products: "Lunch" + "lunch card guest" → centraal lunch
//           "Donation Dinner Sering" → centraal dinner
//           "Staff & volunteers meals" → centraal staff
// Date format: "DD/MM/YY HH:MM" in "Creation Date" column.

function categorizeLightspeedData(rows) {
  const aggregated = emptyAggregated();
  const timeEvents = [];
  let totalMealRows = 0;

  for (const row of rows) {
    const name = row['Name'];
    const qty = parseInt(row['Quantity']) || 0;
    if (qty <= 0) continue;

    const dateStr = row['Creation Date'];
    const date = parseLightspeedDate(dateStr);
    if (!date) continue;
    const hour = parseLightspeedHour(dateStr);
    const minuteOfDay = parseLightspeedMinuteOfDay(dateStr);

    let meal = null;
    if (name === 'Lunch' || name === 'lunch card guest') {
      totalMealRows += qty;
      aggregated.centraal.lunch[date] = (aggregated.centraal.lunch[date] || 0) + qty;
      meal = 'lunch';
    } else if (name === 'Donation Dinner Sering') {
      totalMealRows += qty;
      aggregated.centraal.dinner[date] = (aggregated.centraal.dinner[date] || 0) + qty;
      meal = 'dinner';
    } else if (name === 'Staff & volunteers meals') {
      totalMealRows += qty;
      if (hour < 17) {
        aggregated.centraal.lunch[date] = (aggregated.centraal.lunch[date] || 0) + qty;
        aggregated.centraal.staff_lunch[date] = (aggregated.centraal.staff_lunch[date] || 0) + qty;
        meal = 'lunch';
      } else {
        aggregated.centraal.dinner[date] = (aggregated.centraal.dinner[date] || 0) + qty;
        aggregated.centraal.staff_dinner[date] = (aggregated.centraal.staff_dinner[date] || 0) + qty;
        meal = 'dinner';
      }
    }
    if (meal && minuteOfDay !== null) {
      for (let q = 0; q < qty; q++) {
        timeEvents.push({ loc: 'centraal', meal, date, minuteOfDay });
      }
    }
  }

  return { aggregated, totalMealRows, timeEvents };
}

// Extract minute-of-day from Lightspeed "D/MM/YY HH:MM" → integer (0-1439)
function parseLightspeedMinuteOfDay(dateStr) {
  if (!dateStr) return null;
  const timePart = dateStr.split(' ')[1];
  if (!timePart) return null;
  const [h, m] = timePart.split(':');
  return (parseInt(h) || 0) * 60 + (parseInt(m) || 0);
}

// Extract hour from Lightspeed date "D/MM/YY HH:MM" → integer hour
function parseLightspeedHour(dateStr) {
  if (!dateStr) return 12;
  const timePart = dateStr.split(' ')[1];
  if (!timePart) return 12;
  return parseInt(timePart.split(':')[0]) || 12;
}

// Parse "D/MM/YY HH:MM" or "DD/MM/YY HH:MM" → "YYYY-MM-DD"
function parseLightspeedDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split(' ')[0]; // strip time
  const [day, month, year] = parts.split('/');
  if (!day || !month || !year) return null;
  const fullYear = parseInt(year) < 100 ? 2000 + parseInt(year) : parseInt(year);
  return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// ── Tebi ProductOrders Categorizer (original format) ────────────────────────
// Individual transactions with device-based location detection.

function categorizeTebiData(allRows, existingDeviceMap) {
  const deviceMap = { ...(existingDeviceMap || {}) };

  // Products that tell us a device's location (unambiguous markers)
  const WEST_MARKERS = ['Dinner donation', 'Stadspas Dinner'];
  const CENTRAAL_MARKERS = ['DSC Dinner'];

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
  const aggregated = emptyAggregated();
  const timeEvents = [];
  let totalMealRows = 0;
  let unmappedRows = 0;
  const MEAL_NAMES = ['Lunch', 'Lunch card guest', 'Dinner donation', 'Stadspas Dinner', 'DSC Dinner', 'Staff & volunteer meals'];

  for (const row of allRows) {
    const name = row['Product name'];
    if (!MEAL_NAMES.includes(name)) continue;

    const qty = parseInt(row['Quantity']) || 0;
    if (qty <= 0) continue;
    const date = row['Business day'];
    if (!date) continue;

    // Determine location
    let loc = FIXED_LOCATION[name];
    if (!loc) {
      const deviceId = extractDeviceId(row['Invoice ID']);
      loc = deviceMap[deviceId];
    }
    if (!loc) { unmappedRows++; continue; }

    totalMealRows++;
    const minuteOfDay = extractMinuteOfDayFromTebiRow(row);

    let meal = null;
    if (name === 'Lunch' || name === 'Lunch card guest') {
      aggregated[loc].lunch[date] = (aggregated[loc].lunch[date] || 0) + qty;
      meal = 'lunch';
    } else if (name === 'Dinner donation' || name === 'Stadspas Dinner' || name === 'DSC Dinner') {
      aggregated[loc].dinner[date] = (aggregated[loc].dinner[date] || 0) + qty;
      meal = 'dinner';
    } else if (name === 'Staff & volunteer meals') {
      const hour = extractHourFromTebiRow(row);
      if (hour < 17) {
        aggregated[loc].lunch[date] = (aggregated[loc].lunch[date] || 0) + qty;
        aggregated[loc].staff_lunch[date] = (aggregated[loc].staff_lunch[date] || 0) + qty;
        meal = 'lunch';
      } else {
        aggregated[loc].dinner[date] = (aggregated[loc].dinner[date] || 0) + qty;
        aggregated[loc].staff_dinner[date] = (aggregated[loc].staff_dinner[date] || 0) + qty;
        meal = 'dinner';
      }
    }
    if (meal && minuteOfDay !== null) {
      for (let q = 0; q < qty; q++) {
        timeEvents.push({ loc, meal, date, minuteOfDay });
      }
    }
  }

  const allDates = new Set();
  for (const loc of ['west', 'centraal']) {
    for (const meal of AGG_MEALS) {
      Object.keys(aggregated[loc][meal]).forEach(d => allDates.add(d));
    }
  }
  const sortedDates = [...allDates].sort();

  return {
    aggregated,
    deviceMap,
    timeEvents,
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
        westStaff: Object.keys(aggregated.west.staff_lunch).length + Object.keys(aggregated.west.staff_dinner).length,
        centraalLunch: Object.keys(aggregated.centraal.lunch).length,
        centraalDinner: Object.keys(aggregated.centraal.dinner).length,
        centraalStaff: Object.keys(aggregated.centraal.staff_lunch).length + Object.keys(aggregated.centraal.staff_dinner).length,
      }
    }
  };
}

// Extract minute-of-day from Tebi "Date closed" column (local time) → integer (0-1439) or null
// Format: "3/16/26, 12:03 PM" or "3/16/26, 6:30 PM"
// Falls back to Invoice ID timestamp (UTC) if Date closed is unavailable
function extractMinuteOfDayFromTebiRow(row) {
  const dateClosed = row['Date closed'] || '';
  // Try "Date closed" first — it's in local time
  const match12h = dateClosed.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match12h) {
    let h = parseInt(match12h[1]);
    const m = parseInt(match12h[2]);
    const ampm = match12h[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  }
  // Fallback: Invoice ID UTC timestamp (less accurate — off by timezone)
  const invoiceId = row['Invoice ID'] || '';
  const parts = invoiceId.split('|');
  if (parts.length >= 2) {
    const matchUtc = parts[1].match(/T(\d{2}):(\d{2})/);
    if (matchUtc) return parseInt(matchUtc[1]) * 60 + parseInt(matchUtc[2]);
  }
  return null;
}

// Extract hour from a Tebi ProductOrders row.
// Invoice ID has a timestamp: "723192|2026-03-16T16:30:00Z|INVOICE|..."
function extractHourFromTebiRow(row) {
  const invoiceId = row['Invoice ID'] || '';
  const parts = invoiceId.split('|');
  if (parts.length >= 2) {
    const ts = parts[1]; // "2026-03-16T16:30:00Z"
    const match = ts.match(/T(\d{2}):/);
    if (match) return parseInt(match[1]);
  }
  return 12; // default to noon if can't parse
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

    for (const meal of ['lunch', 'dinner', 'staff_lunch', 'staff_dinner']) {
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

// ── Day Navigation Helpers (shared by Guests + Planner tabs) ────────────────

// Build an array of 7 visible days starting from today + offset.
// Each entry has: date, dayName, dayIdx, isToday, isPast, mondayKey, isCurrentWeek.
function getVisibleDays(offset) {
  const today = getToday();
  const todayStr = today.toDateString();

  // Find the current week's Monday for comparison
  const todayDow = today.getDay();
  const curMondayOff = todayDow === 0 ? -6 : 1 - todayDow;
  const curMonday = new Date(today);
  curMonday.setDate(today.getDate() + curMondayOff);
  const curMondayStr = localDateStr(curMonday);

  return Array.from({length: 7}, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + offset + i);
    const dayIdx = (d.getDay() + 6) % 7; // 0=Mon, 6=Sun
    const mk = getMondayKeyForDate(d);
    return {
      date: d,
      dayName: DAYS[dayIdx],
      dayIdx,
      isToday: d.toDateString() === todayStr,
      isPast: d < today && d.toDateString() !== todayStr,
      mondayKey: mk,
      isCurrentWeek: mk === curMondayStr
    };
  });
}

// Get the Monday date key (YYYY-MM-DD) for the week a date belongs to
function getMondayKeyForDate(d) {
  const dow = d.getDay(); // 0=Sun
  const off = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d);
  mon.setDate(d.getDate() + off);
  return localDateStr(mon);
}

// Format a Date as YYYY-MM-DD using local timezone (avoids UTC shift)
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Render the day-navigation header bar used by both Guests and Planner
function renderDayNav(offset, minOffset, maxOffset, changeFn, extraHtml) {
  const days = getVisibleDays(offset);
  const first = days[0].date;
  const last = days[6].date;
  const shortDate = d => `${d.getDate()}/${d.getMonth()+1}`;
  const monthYear = first.toLocaleDateString('en-GB', {month:'short', year:'numeric'});

  let html = `<div class="gt-header">
    <div class="gt-nav">
      <button class="gt-nav-btn" onclick="${changeFn}(-1)" ${offset <= minOffset ? 'disabled' : ''} title="Previous day">&larr;</button>
      <div class="gt-week-label">`;
  if (offset !== 0) {
    html += `<button class="gt-today-btn" onclick="${changeFn}(-${offset})" title="Back to today">Today</button>`;
  }
  html += `<span class="gt-week-dates">${shortDate(first)} — ${shortDate(last)} ${monthYear}</span>
      </div>
      <button class="gt-nav-btn" onclick="${changeFn}(1)" ${offset + 6 >= maxOffset ? 'disabled' : ''} title="Next day">&rarr;</button>
    </div>
    <div class="gt-header-actions">${extraHtml || ''}</div>
  </div>`;
  return html;
}
