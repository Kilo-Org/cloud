/**
 * PostgreSQL JSONB rejects escaped NUL characters and lone UTF-16 surrogates.
 * JavaScript strings can contain both, so repair them before sending values to
 * a JSONB column.
 */
function sanitizeJsonbString(value: string): string {
  if (value.isWellFormed() && !value.includes('\0')) {
    return value;
  }

  return value.toWellFormed().replaceAll('\0', '\ufffd');
}

export function sanitizeJsonbValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeJsonbString(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeJsonbValue);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        sanitizeJsonbString(key),
        sanitizeJsonbValue(nestedValue),
      ])
    );
  }

  return value;
}
