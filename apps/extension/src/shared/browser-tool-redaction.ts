/**
 * Value redaction for browser network tool output, shared by both renderers.
 */
import { z } from 'zod';

/** Values of headers whose name matches one of these fragments are replaced. */
const REPLACED_HEADER_NAME_FRAGMENTS = [
  'authorization',
  'cookie',
  'token',
  'api-key',
  'apikey',
  'secret',
  'session',
  'signature',
  'csrf',
  'xsrf',
] as const;

/** Values of JSON or form keys matching one of these fragments are replaced. */
const REPLACED_BODY_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api-key',
  'apikey',
  'api_key',
  'authorization',
  'credential',
  'session',
  'csrf',
  'xsrf',
] as const;

const BODY_MASK = '[REDACTED]';

const matchesAnyFragment = (name: string, fragments: readonly string[]): boolean => {
  const folded = name.toLowerCase();

  return fragments.some(fragment => folded.includes(fragment));
};

/**
 * Returns a shallow copy of the headers record with the value of every header
 * whose name matches a listed fragment replaced by `"[REDACTED]"`.
 */
export const redactSensitiveHeaders = (
  headers: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined => {
  if (headers === undefined) {
    return undefined;
  }

  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    result[name] = matchesAnyFragment(name, REPLACED_HEADER_NAME_FRAGMENTS) ? BODY_MASK : value;
  }

  return result;
};

/**
 * The JSON value shapes a request body can carry. Parsed values are the JSON
 * primitives, arrays, and plain objects; anything else fails the walk and
 * leaves the body untouched.
 */
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

const jsonValueUnion = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.lazy(() => jsonValueSchema)),
  z.record(
    z.string(),
    z.lazy(() => jsonValueSchema)
  ),
]);

/** A zod schema matching the JSON value union, built once at module init. */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => jsonValueUnion as z.ZodType<JsonValue>);

const isJsonContainer = (value: JsonValue): value is Exclude<JsonValue, null> =>
  value !== null && (Array.isArray(value) || value instanceof Object);

const redactJsonContainer = (value: Exclude<JsonValue, null>): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(element =>
      isJsonContainer(element) ? redactJsonContainer(element) : element
    );
  }

  const result: JsonObject = {};

  for (const [key, rawEntry] of Object.entries(value)) {
    const entry: JsonValue = jsonValueSchema.parse(rawEntry);

    if (matchesAnyFragment(key, REPLACED_BODY_KEY_FRAGMENTS)) {
      result[key] = BODY_MASK;
    } else if (isJsonContainer(entry)) {
      result[key] = redactJsonContainer(entry);
    } else {
      result[key] = entry;
    }
  }

  return result;
};

const redactJsonBody = (text: string): string | undefined => {
  let raw: unknown = undefined;

  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }

  const parsed = jsonValueSchema.safeParse(raw);

  if (!parsed.success || !isJsonContainer(parsed.data)) {
    return undefined;
  }

  return JSON.stringify(redactJsonContainer(parsed.data), null, 2);
};

/**
 * Returns the body text with the value of every field whose key matches a
 * listed fragment replaced, or `undefined` when the text is not structured.
 */
export const redactSensitiveBody = (text: string): string | undefined => {
  const trimmed = text.trimStart();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return redactJsonBody(text);
    } catch {
      return undefined;
    }
  }

  if (trimmed.includes('=')) {
    return redactFormBody(text);
  }

  return undefined;
};

/**
 * Replaces urlencoded and multipart form field values whose name matches a
 * listed fragment. urlencoded pairs split on `&`; multipart entries split on
 * their boundary and rejoin untouched, so only matching field values change.
 */
const redactFormBody = (text: string): string | undefined => {
  // A leading `--` line marks a multipart body; the urlencoded path handles the rest.
  if (/(?:boundary=|^--[^\r\n]+$)/im.test(text)) {
    return redactMultipartBody(text);
  }

  const pairs = text.split('&');

  // A urlencoded body is only `name=value` pairs; other text passes through unchanged.
  const isUrlencoded = pairs.length > 0 && pairs.every(pair => /^[\w.~%$-]+=.*/u.test(pair));

  if (!isUrlencoded) {
    return undefined;
  }

  const masked = pairs.map(pair => {
    const separator = pair.indexOf('=');

    if (separator === -1) {
      return pair;
    }

    const name = pair.slice(0, separator);

    return matchesAnyFragment(name, REPLACED_BODY_KEY_FRAGMENTS) ? `${name}=${BODY_MASK}` : pair;
  });

  return masked.join('&');
};

const MULTIPART_FIELD_NAME_PATTERN = /name="([^"]*)"/u;

const redactMultipartBody = (text: string): string | undefined => {
  const lines = text.split('\r\n');
  let changed = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const disposition = line === undefined ? null : line.match(MULTIPART_FIELD_NAME_PATTERN);

    if (
      disposition !== null &&
      matchesAnyFragment(disposition[1] ?? '', REPLACED_BODY_KEY_FRAGMENTS)
    ) {
      const valueIndex = index + 2;

      if (valueIndex < lines.length && lines[valueIndex] !== '') {
        lines[valueIndex] = BODY_MASK;
        changed = true;
      }
    }

    index += 1;
  }

  return changed ? lines.join('\r\n') : undefined;
};
