/**
 * Value redaction for browser network tool output, shared by both renderers.
 */
/* eslint-disable max-lines -- header, JSON, form, and base64 replacement stay in one module so every renderer shares one rule set */
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
  'private_key',
  'privatekey',
  'private-key',
] as const;

const BODY_MASK = '[REDACTED]';

/**
 * A PEM label line. RFC 7468 labels are uppercase, so the match stays
 * case-sensitive. The optional words before `PRIVATE KEY` cover the typed
 * labels (`RSA`, `EC`, `OPENSSH`, `ENCRYPTED`) and the `PGP PRIVATE KEY BLOCK`
 * form, while `PUBLIC KEY` and certificate labels stay unmatched.
 */
const PRIVATE_KEY_MATERIAL_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/u;

const matchesAnyFragment = (name: string, fragments: readonly string[]): boolean => {
  const folded = name.toLowerCase();

  return fragments.some(fragment => folded.includes(fragment));
};

/**
 * A private-key block: the BEGIN label line through the matching END line, or
 * through the end of the text when the block is truncated, so text around the
 * block survives the replacement. `BLOCK` covers the PGP armor label.
 */
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu;

/**
 * Whether the text carries PEM private-key material, whatever the name of the
 * field around it. A value that arrived percent-encoded is tested decoded too,
 * so an urlencoded form stays covered; a malformed escape matches nothing.
 */
const containsPrivateKeyMaterial = (text: string): boolean => {
  if (PRIVATE_KEY_MATERIAL_PATTERN.test(text)) {
    return true;
  }

  if (!text.includes('%') && !text.includes('+')) {
    return false;
  }

  try {
    return PRIVATE_KEY_MATERIAL_PATTERN.test(decodeURIComponent(text.replaceAll('+', ' ')));
  } catch {
    return false;
  }
};

/**
 * Replaces each PEM private-key block in text that has no structured body
 * shape, keeping the text around it, or `undefined` when nothing matched.
 */
const redactUnstructuredBody = (text: string): RedactedBody | undefined => {
  const masked = text.replaceAll(PRIVATE_KEY_BLOCK_PATTERN, BODY_MASK);

  return masked === text ? undefined : { changed: true, text: masked };
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

/** A parsed JSON string leaf, as opposed to a number, boolean, null, array, or object. */
const isJsonString = (value: JsonValue): value is string =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a value that already passed jsonValueSchema; the walk branches on the leaf kind and a schema parse per value would allocate for every string in the body
  typeof value === 'string';

/** A redacted rendering plus whether the walk replaced any value. */
interface RedactedBody {
  readonly changed: boolean;
  readonly text: string;
}

interface RedactedJson {
  readonly changed: boolean;
  readonly value: JsonValue;
}

const redactJsonContainer = (value: Exclude<JsonValue, null>): RedactedJson => {
  if (Array.isArray(value)) {
    let changed = false;

    const elements = value.map(element => {
      if (isJsonContainer(element)) {
        const nested = redactJsonContainer(element);
        changed ||= nested.changed;

        return nested.value;
      }

      if (isJsonString(element) && containsPrivateKeyMaterial(element)) {
        changed = true;

        return BODY_MASK;
      }

      return element;
    });

    return { changed, value: elements };
  }

  let changed = false;
  const result: JsonObject = {};

  for (const [key, rawEntry] of Object.entries(value)) {
    const entry: JsonValue = jsonValueSchema.parse(rawEntry);

    if (matchesAnyFragment(key, REPLACED_BODY_KEY_FRAGMENTS)) {
      result[key] = BODY_MASK;
      changed = true;
    } else if (isJsonContainer(entry)) {
      const nested = redactJsonContainer(entry);
      changed ||= nested.changed;
      result[key] = nested.value;
    } else if (isJsonString(entry) && containsPrivateKeyMaterial(entry)) {
      result[key] = BODY_MASK;
      changed = true;
    } else {
      result[key] = entry;
    }
  }

  return { changed, value: result };
};

const redactJsonBody = (text: string): RedactedBody | undefined => {
  try {
    // Parsing and the recursive walk both run on page-controlled text, so one
    // Guard covers them: a stack overflow from a deeply nested body falls back
    // To the unstructured pass instead of failing the tool call.
    const raw: unknown = JSON.parse(text);
    const parsed = jsonValueSchema.safeParse(raw);

    if (!parsed.success || !isJsonContainer(parsed.data)) {
      return undefined;
    }

    const redacted = redactJsonContainer(parsed.data);

    return { changed: redacted.changed, text: JSON.stringify(redacted.value, null, 2) };
  } catch {
    return undefined;
  }
};

const redactBodyText = (text: string): RedactedBody | undefined => {
  const trimmed = text.trimStart();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = redactJsonBody(text);

    if (json !== undefined) {
      return json;
    }
  } else if (trimmed.includes('=')) {
    const form = redactFormBody(text);

    if (form !== undefined) {
      // The pair pass leaves a segment without a separator alone, so the block
      // Pass still runs over its output.
      return { changed: true, text: redactUnstructuredBody(form)?.text ?? form };
    }
  }

  // A body with no structured shape, such as a plain text or key-file download,
  // Still gets the block replacement.
  return redactUnstructuredBody(text);
};

/**
 * Returns the body text with the value of every field whose key matches a
 * listed fragment replaced, or `undefined` when the text is not structured.
 */
export const redactSensitiveBody = (text: string): string | undefined => redactBodyText(text)?.text;

const decodeBase64Text = (payload: string): string | undefined => {
  try {
    // The atob helper strips ASCII whitespace itself, so wrapped payloads need no normalization.
    const bytes = Uint8Array.from(atob(payload), character => character.codePointAt(0) ?? 0);

    // Fatal decoding rejects binary payloads instead of returning replacement glyphs.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * Longest base64 payload decoded for replacement, several times the rendered
 * body cap, so a page-controlled binary payload is never materialized again
 * just to be truncated afterwards.
 */
const MAX_BASE64_PAYLOAD_LENGTH = 100_000;

/**
 * Returns the decoded text of a base64 payload whose structured form has a
 * value replaced, or `undefined` when the payload is oversized, binary, not
 * base64, or has nothing to replace, so callers keep the original rendering.
 */
export const redactSensitiveBase64Body = (payload: string): string | undefined => {
  if (payload === '' || payload.length > MAX_BASE64_PAYLOAD_LENGTH) {
    return undefined;
  }

  const decoded = decodeBase64Text(payload);
  const redacted = decoded === undefined ? undefined : redactBodyText(decoded);

  return redacted !== undefined && redacted.changed ? redacted.text : undefined;
};

/**
 * Response body text for a CDP body, with the shared replacement applied. A
 * base64 body keeps a marker; a decoded body states that it was decoded.
 */
export const renderResponseBody = (body: string, base64Encoded: boolean | undefined): string => {
  if (base64Encoded !== true) {
    return redactSensitiveBody(body) ?? body;
  }

  const decoded = redactSensitiveBase64Body(body);

  return decoded === undefined ? `(base64) ${body}` : `(base64, decoded) ${decoded}`;
};

/**
 * Replaces urlencoded and multipart form field values whose name matches a
 * listed fragment. Multipart detection is anchored to a real delimiter line;
 * anything else is treated as urlencoded and redacted pair by pair, so a
 * stray non-pair segment never disables the pass.
 */
const redactFormBody = (text: string): string | undefined => {
  // A line of `--<boundary>` delimiters plus a part header marks a multipart
  // Body; text whose lines merely start with `--` stays urlencoded and still
  // Gets the pair pass.
  if (/^--[^\r\n]+\r?$/m.test(text) && /^content-disposition:/im.test(text)) {
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

    if (
      !matchesAnyFragment(name, REPLACED_BODY_KEY_FRAGMENTS) &&
      !containsPrivateKeyMaterial(pair.slice(separator + 1))
    ) {
      return pair;
    }

    changed = true;

    return `${name}=${BODY_MASK}`;
  });

  return changed ? masked.join('&') : undefined;
};

/** A part header line: every `form-data` disposition starts a part, named or not. */
const MULTIPART_PART_PATTERN = /^content-disposition:.*\bform-data\b/iu;

/** The `name` parameter, quoted or as a bare token, so a file part without one is still a part. */
const MULTIPART_FIELD_NAME_PATTERN = /;\s*name="?([^";\r\n]*)"?/iu;

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
    const line = lines[index] ?? '';
    const isPart = MULTIPART_PART_PATTERN.test(line);

    let nextIndex = index + 1;

    if (isPart) {
      const name = MULTIPART_FIELD_NAME_PATTERN.exec(line)?.[1] ?? '';

      // Skip the part's header lines to the blank separator, then the value
      // Region up to the next delimiter line, keeping the delimiter. The header
      // Scan stops at a delimiter too, so a part without a separator line cannot
      // Consume the next part's header.
      let valueIndex = index + 1;

      while (
        valueIndex < lines.length &&
        lines[valueIndex] !== '' &&
        !isDelimiter(lines[valueIndex] ?? '')
      ) {
        valueIndex += 1;
      }

      const hasSeparator = lines[valueIndex] === '';

      if (hasSeparator) {
        valueIndex += 1;
      }

      let endIndex = valueIndex;

      while (endIndex < lines.length && !isDelimiter(lines[endIndex] ?? '')) {
        endIndex += 1;
      }

      const hasValue = hasSeparator && endIndex > valueIndex;

      if (
        hasValue &&
        (matchesAnyFragment(name, REPLACED_BODY_KEY_FRAGMENTS) ||
          containsPrivateKeyMaterial(lines.slice(valueIndex, endIndex).join('\r\n')))
      ) {
        lines.splice(valueIndex, endIndex - valueIndex, BODY_MASK);
        changed = true;
      }

      nextIndex = valueIndex;
    }

    index = nextIndex;
  }

  return changed ? lines.join('\r\n') : undefined;
};
