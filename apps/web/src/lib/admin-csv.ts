/** Wrap a CSV field value in quotes if it contains commas, quotes, or newlines. */
export function csvField(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export type CsvTableData = {
  headers: string[];
  rows: Record<string, string>[];
};

/** Parse a CSV string into a table structure with headers and rows. */
export function parseCsvToTable(text: string): CsvTableData {
  const lines = text.trim().split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          parts.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    parts.push(current.trim());
    return parts;
  };

  const headers = parseLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? '';
    });
    rows.push(row);
  }

  return { headers, rows };
}

/** Extract unique, lowercase emails from a specific column of parsed CSV rows. */
export function extractEmailsFromColumn(rows: Record<string, string>[], column: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const row of rows) {
    const val = (row[column] ?? '').toLowerCase().trim();
    if (val && val.includes('@') && val.includes('.') && !seen.has(val)) {
      seen.add(val);
      emails.push(val);
    }
  }
  return emails;
}

/** Guess which CSV column contains email addresses. */
export function guessEmailColumn(headers: string[], rows: Record<string, string>[]): string | null {
  const emailHeader = headers.find(h => h.toLowerCase().trim() === 'email');
  if (emailHeader) return emailHeader;

  let bestCol: string | null = null;
  let bestCount = 0;
  for (const h of headers) {
    let count = 0;
    for (const row of rows) {
      const val = (row[h] ?? '').trim();
      if (val.includes('@') && val.includes('.')) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestCol = h;
    }
  }
  return bestCount > 0 ? bestCol : null;
}

/**
 * Parse a free-form string of emails (newlines, commas, semicolons, spaces)
 * into a deduplicated list of lowercase emails.
 */
export function parseEmailList(text: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  const parts = text.split(/[\n,;\s]+/);
  for (const part of parts) {
    const val = part
      .replace(/^[<"'\s]+|[>"'\s]+$/g, '')
      .toLowerCase()
      .trim();
    if (val && val.includes('@') && val.includes('.') && !seen.has(val)) {
      seen.add(val);
      emails.push(val);
    }
  }
  return emails;
}

/** Trigger a browser CSV download. Must only be called from client-side code. */
export function downloadCsv(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
