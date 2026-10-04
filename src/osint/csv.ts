/**
 * Minimal CSV utilities (parse + stringify) for the OSINT toolkit port.
 * Handles quoted fields, escaped quotes, and CRLF/LF line endings — enough
 * for LinkedIn scraper CSVs (name, title, profile_url, ...) without adding a
 * dependency.
 */

/** Parse CSV text into rows of fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    // Skip completely empty trailing rows
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      pushField();
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Final field/row without trailing newline
  if (field !== '' || row.length > 0) {
    pushField();
    pushRow();
  }
  return rows;
}

/** Parse CSV text into objects keyed by the header row. */
export function parseCsvObjects(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    header.forEach((key, idx) => {
      obj[key.trim()] = row[idx] ?? '';
    });
    return obj;
  });
}

/** Escape a single CSV field (quotes when needed). */
export function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize objects to CSV text with the given column order. */
export function stringifyCsv(
  items: Array<Record<string, unknown>>,
  columns: string[],
): string {
  const lines = [columns.join(',')];
  for (const item of items) {
    lines.push(columns.map((c) => csvField(item[c])).join(','));
  }
  return lines.join('\n') + '\n';
}
