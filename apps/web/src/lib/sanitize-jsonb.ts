/**
 * PostgreSQL JSONB rejects JSON strings containing escaped lone UTF-16
 * surrogates. JavaScript can receive those values from JSON.parse, so repair
 * them before sending values to a JSONB column.
 */
function replaceUnpairedSurrogates(value: string): string {
  let result = '';
  let changed = false;

  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = value.charCodeAt(index + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        result += value[index] + value[index + 1];
        index++;
      } else {
        result += '\ufffd';
        changed = true;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += '\ufffd';
      changed = true;
    } else {
      result += value[index];
    }
  }

  return changed ? result : value;
}

export function sanitizeJsonbValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return replaceUnpairedSurrogates(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeJsonbValue);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        replaceUnpairedSurrogates(key),
        sanitizeJsonbValue(nestedValue),
      ])
    );
  }

  return value;
}
