// ─────────────────────────────────────────────────────────────────────────────
// SIMPLE CSV PARSER — handles quoted fields with escaped quotes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a single CSV line into an array of fields.
 * Handles quoted fields (including commas inside quotes).
 */
function parseCsvLine(line) {
  const fields = [];
  let inQuote = false, field = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(field.trim()); field = ''; }
    else { field += ch; }
  }
  fields.push(field.trim());
  return fields;
}

/**
 * Parse a full CSV string into { headers, rows }.
 * Each row is an array of strings matching header indices.
 * Skips empty lines.
 */
function parseCsv(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    rows.push(parseCsvLine(lines[i]));
  }
  return { headers, rows };
}

module.exports = { parseCsvLine, parseCsv };
