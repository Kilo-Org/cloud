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
 * listed fragment. Multipart detection is anchored to a real delimiter line;
 * anything else is treated as urlencoded and redacted pair by pair, so a
 * stray non-pair segment never disables the pass.
 */
const redactFormBody = (text: string): string | undefined => {
  // A line of `--<boundary>` delimiters marks a multipart body.
  if (/^--[^\r\n]+\r?$/m.test(text)) {
    return redactMultipartBody(text);
  }

  const pairs = text.split('&');
  let changed = false;

  const masked = pairs.map(pair => {
    const separator = pair.indexOf('=');

    if (separator <= 0) {
      return pair;
    }

    const name = pair.slice(0, separator);

    if (!matchesAnyFragment(name, REPLACED_BODY_KEY_FRAGMENTS)) {
      return pair;
    }

    changed = true;

    return `${name}=${BODY_MASK}`;
  });

  return changed ? masked.join('&') : undefined;
};

const MULTIPART_FIELD_NAME_PATTERN = /name="([^"]*)"/u;

const redactMultipartBody = (text: string): string | undefined => {
  const lines = text.split('\r\n');

  // The first `--<token>` line defines the boundary; later lines match it,
  // Optionally followed by the closing `--`, so values that merely begin with
  // `--` are not mistaken for delimiters.
  const boundaryToken = lines.find(line => /^--[^\r\n]*\r?$/u.test(line)) ?? '';
  const isDelimiter = (line: string): boolean =>
    boundaryToken !== '' && (line === boundaryToken || line.startsWith(`${boundaryToken}--`));

  let changed = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const disposition = line === undefined ? null : line.match(MULTIPART_FIELD_NAME_PATTERN);
    const isMatch =
      disposition !== null && matchesAnyFragment(disposition[1] ?? '', REPLACED_BODY_KEY_FRAGMENTS);

    if (isMatch) {
      // Skip the part's header lines to the blank separator, then replace the
      // Whole value region up to the next delimiter line, keeping the delimiter.
      let valueIndex = index + 1;

      while (valueIndex < lines.length && lines[valueIndex] !== '') {
        valueIndex += 1;
      }
      valueIndex += 1;

      let endIndex = valueIndex;

      while (endIndex < lines.length && !isDelimiter(lines[endIndex] ?? '')) {
        endIndex += 1;
      }

      if (endIndex > valueIndex) {
        lines.splice(valueIndex, endIndex - valueIndex, BODY_MASK);
        index = valueIndex;
        changed = true;
      } else {
        index = valueIndex;
      }
    } else {
      index += 1;
    }
  }

  return changed ? lines.join('\r\n') : undefined;
};
