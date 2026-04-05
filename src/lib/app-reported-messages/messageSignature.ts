export type MessageTypeSignature =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | MessageTypeSignature[]
  | { [key: string]: MessageTypeSignature };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function tryJsonParse(value: string): { ok: true; parsed: unknown } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(value);
    return { ok: true, parsed };
  } catch {
    return { ok: false };
  }
}

/**
 * Recursively parses JSON-encoded strings inside a value.
 *
 * Rules:
 * - If a value is a string, attempt to `JSON.parse` it.
 * - If successful, replace the string with the parsed value and repeat (in case the JSON value is
 *   itself a JSON-encoded string).
 * - Continue recursively through arrays and plain objects.
 *
 * This is pure and deterministic (object keys are processed in sorted order).
 */
export function parseJsonStringsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    let current: unknown = value;
    // Keep parsing while we have a JSON-parseable string.
    while (typeof current === 'string') {
      const attempt = tryJsonParse(current);
      if (!attempt.ok) break;
      current = attempt.parsed;
    }

    // If we parsed to a non-string, it may contain nested JSON strings.
    return typeof current === 'string' ? current : parseJsonStringsDeep(current);
  }

  if (Array.isArray(value)) {
    return value.map(v => parseJsonStringsDeep(v));
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = parseJsonStringsDeep(value[key]);
    }
    return out;
  }

  return value;
}

/**
 * Converts a fully-parsed value into a structural type signature.
 *
 * This is pure and deterministic (object keys are processed in sorted order).
 */
export function getTypeSignature(value: unknown): MessageTypeSignature {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';

  if (Array.isArray(value)) {
    return value.map(v => getTypeSignature(v));
  }

  if (isPlainObject(value)) {
    const out: { [key: string]: MessageTypeSignature } = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = getTypeSignature(value[key]);
    }
    return out;
  }

  // Values coming from JSON (request bodies, DB JSONB, etc.) shouldn't hit this branch.
  // Throwing makes unexpected runtime values visible.
  throw new Error(`Unsupported value for signature generation: ${String(value)}`);
}

/**
 * Convenience wrapper that applies JSON-string parsing and then converts to a type signature.
 */
export function generateMessageSignature(message: unknown): MessageTypeSignature {
  const parsed = parseJsonStringsDeep(message);
  return getTypeSignature(parsed);
}
