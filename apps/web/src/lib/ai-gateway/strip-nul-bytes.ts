/**
 * Strip NUL bytes (\u0000) in place from every string-typed field on `value`.
 *
 * Postgres `text` columns reject NUL bytes with `22021 invalid byte sequence
 * for encoding "UTF8": 0x00`, which crashes inserts into affected tables.
 *
 * Any sanitized field paths are appended to `dirtyFields` so the caller can
 * log them for source attribution.
 */
export function stripNulBytesInPlace(value: object, dirtyFields: string[]): void {
  stripNulBytesFromValue(value, dirtyFields, '');
}

function stripNulBytesFromValue(value: unknown, dirtyFields: string[], path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      stripNulBytesFromValue(item, dirtyFields, `${path}[${index}]`);
    });
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    const itemPath = path ? `${path}.${key}` : key;
    if (typeof item === 'string' && item.indexOf('\u0000') >= 0) {
      value[key] = item.split('\u0000').join('');
      dirtyFields.push(itemPath);
      continue;
    }

    stripNulBytesFromValue(item, dirtyFields, itemPath);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
