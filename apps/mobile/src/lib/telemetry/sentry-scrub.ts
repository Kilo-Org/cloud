/**
 * Pure total Sentry event and breadcrumb scrubbers.
 *
 * Every function wraps its body so an unexpected payload shape returns the
 * input unchanged rather than throwing. A throwing `beforeSend` or
 * `beforeBreadcrumb` drops the event silently, which would hide crashes.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns,
 * anti-slop/no-known-value-widening -- Sentry event/breadcrumb payloads are
 * external, arbitrarily shaped, and must never throw on a malformed shape; a
 * zod schema for the full Sentry Event/Breadcrumb type would risk silently
 * dropping fields this walker isn't meant to know about. The scrubbers must
 * therefore accept and return opaque values. */

/** Strip the query string from a URL. Returns empty string if parsing fails. */
function stripQuery(url: unknown): string {
  if (typeof url !== 'string') {
    return '';
  }
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.slice(0, idx);
}

/** A `scheme://host[:port]` origin. */
const URL_ORIGIN_PATTERN = /\b[a-z][\da-z+.-]*:\/\/[^\s/]+/giu;

/** An absolute path of two or more segments, optionally with `:line:col`. */
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:)?(?:\/[\w.@+-]+){2,}(?::\d+){0,2}\/?/gu;

/**
 * A `host:port` run, in the plain or the Java-style `/host:port` form.
 *
 * The leading group consumes the character before the run (or matches the start
 * of the string), so the engine only begins a host scan at a token boundary and
 * never inside a word run. The old unanchored `\/?(?:[\w-]+\.)*[\w-]+:\d` form
 * restarted a full host scan at every character of a long word run, which is
 * quadratic: a 32k-character exception message spent seconds on the JS thread
 * inside `beforeSend`. The host itself is one character class with no nested
 * quantifier, and the leading character is kept by the replacement (`$1`).
 */
const HOST_PORT_PATTERN = /(^|[^\w.-])\/?[\w.-]+:\d{1,5}\b/gu;

/** A `?query` run: a `?` followed by non-space key/value text. */
const QUERY_FRAGMENT_PATTERN = /\?[^\s]+/gu;

/**
 * Remove the values that identify the machine or the build rather than the
 * defect: a URL's scheme and host, an absolute build/worktree path, a
 * `host:port` pair, and a query string. Used only to build a fingerprint
 * fallback, never as the message the issue shows: the goal is that two events
 * of one defect produce one group key even though their paths and ports differ.
 */
function stripVolatileValues(message: string): string {
  return message
    .replace(URL_ORIGIN_PATTERN, '<host>')
    .replace(ABSOLUTE_PATH_PATTERN, '<path>')
    .replace(HOST_PORT_PATTERN, '$1<host>')
    .replace(QUERY_FRAGMENT_PATTERN, '');
}

/** One run of 20+ consecutive base64url characters (A-Z a-z 0-9 - _). */
const TOKEN_RUN_PATTERN = /[A-Za-z0-9_-]{20,}/g;

/** A chain of lowercase words: `agent-message-render`, `render_part`. */
const LOWERCASE_WORD_CHAIN_PATTERN = /^[a-z]+(?:[-_][a-z]+)+$/;

/** A chain of CapitalizedWords: React's `MessageErrorBoundary`. */
const CAPITALIZED_WORD_CHAIN_PATTERN = /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/;

/** True when a token-shaped run is a word chain, i.e. maybe a name. */
function isIdentifierRun(run: string): boolean {
  return LOWERCASE_WORD_CHAIN_PATTERN.test(run) || CAPITALIZED_WORD_CHAIN_PATTERN.test(run);
}

/**
 * The exact event paths whose own value is a contractually app-set identifier
 * rather than payload data: the `error.subsystem` / `error.operation` tags the
 * app writes, and the React `componentStack` the render boundary attaches as a
 * direct `extra` field. Each entry is `<section>.<field>` for one of the maps
 * {@link scrubEvent} walks.
 *
 * The exemption is keyed on the full path, never on a bare property name: a
 * `componentStack` or `error.subsystem` nested inside another object is payload
 * data, and a word-chain secret there (`my-super-secret-prod-token`) must be
 * redacted like anywhere else. The shape alone is not proof a run is safe.
 */
const IDENTIFIER_PATHS = new Set([
  'extra.componentStack',
  'tags.error.subsystem',
  'tags.error.operation',
]);

/** True when a value reached through `path` is an app-set identifier field. */
function isIdentifierPath(path: readonly (string | number)[]): boolean {
  if (path.length !== 2) {
    return false;
  }
  const [section, field] = path;
  return (
    typeof section === 'string' &&
    typeof field === 'string' &&
    IDENTIFIER_PATHS.has(`${section}.${field}`)
  );
}

/**
 * Redact every token-shaped run inside one string, keeping the rest of the
 * string so a diagnostic that embeds a long identifier stays readable.
 *
 * A run is 20+ consecutive base64url characters. At an identifier path a run
 * that is a chain of words is a name, not a credential: without that, the app's
 * `agent-message-render` tags and React's `MessageErrorBoundary` component
 * names are delivered as `[redacted]`, and they are the only copy of the
 * diagnostic the app sends. Everywhere else a run is redacted on shape alone. A
 * `Bearer ` prefix names the whole value a credential, so it redacts whole.
 */
function redactString(value: string, keepIdentifiers: boolean): string {
  if (value.startsWith('Bearer ')) {
    return '[redacted]';
  }
  return value.replace(TOKEN_RUN_PATTERN, run =>
    keepIdentifiers && isIdentifierRun(run) ? run : '[redacted]'
  );
}

/**
 * Redact token-shaped runs at any depth in a value tree, returning a scrubbed
 * copy. `path` is the key (or array index) route from the walked map's root, and
 * decides the exemption for a string: only an exact
 * {@link IDENTIFIER_PATHS} route keeps word-chain runs. `seen` maps each
 * visited object to its scrubbed copy, so a repeated or aliased reference
 * resolves to that copy rather than the original (returning the original would
 * leak its unredacted values) and a cycle is bounded.
 */
function redactValue(
  value: unknown,
  seen: WeakMap<object, unknown>,
  path: readonly (string | number)[]
): unknown {
  if (typeof value === 'string') {
    return redactString(value, isIdentifierPath(path));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (let index = 0; index < value.length; index += 1) {
      result.push(redactValue(value[index], seen, [...path, index]));
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) {
    result[key] = redactValue(item, seen, [...path, key]);
  }
  return result;
}

/** Redact every token-shaped value at any depth in a key-value map. */
function redactTokens(
  map: Record<string, unknown> | undefined | null,
  section: string
): Record<string, unknown> | undefined {
  if (map == null) {
    return undefined;
  }
  return redactValue(map, new WeakMap(), [section]) as Record<string, unknown>;
}

/**
 * The context key the network reporter stores a parsed tRPC error body under
 * (see `network-errors.ts`). The value is free-form payload, so
 * {@link scrubEvent} token-scrubs it like extra error data. It must not be the
 * synthesized exception's class name: `extraErrorDataIntegration` writes a
 * thrown error's own properties under `contexts[error.name]`, so a payload
 * under `NetworkError` is replaced with `{}` before `beforeSend` ever runs.
 */
export const NETWORK_BODY_CONTEXT = 'network.body';

/** Context names whose value is app-attached payload and must be token-scrubbed. */
const PAYLOAD_CONTEXT_NAMES: readonly string[] = [NETWORK_BODY_CONTEXT];

/**
 * Names of the thrown errors in an event, i.e. the context keys that
 * `extraErrorDataIntegration` writes a thrown error's own properties under
 * (see lib/sentry-init.ts). Its data is free-form and must be token-scrubbed;
 * Sentry's structured contexts (device, trace, our `network`) are not.
 */
function exceptionContextNames(event: Record<string, unknown>): string[] {
  const exception = event.exception;
  if (exception == null || typeof exception !== 'object') {
    return [];
  }
  const values = (exception as Record<string, unknown>).values;
  if (!Array.isArray(values)) {
    return [];
  }
  const names: string[] = [];
  for (const value of values) {
    if (value != null && typeof value === 'object') {
      const type = (value as Record<string, unknown>).type;
      if (typeof type === 'string' && type.length > 0) {
        names.push(type);
      }
    }
  }
  return names;
}

/**
 * Every context name whose value must be token-scrubbed: the app's payload
 * contexts ({@link PAYLOAD_CONTEXT_NAMES}) plus the thrown-error names
 * {@link exceptionContextNames} finds. Structured contexts stay out.
 */
function redactedContextNames(event: Record<string, unknown>): string[] {
  return [...PAYLOAD_CONTEXT_NAMES, ...exceptionContextNames(event)];
}

/** The string at `key`, or undefined when it is absent or not a string. */
function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

/** The first `exception.values` entry, or undefined when there is none. */
function firstExceptionValue(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const exception = event.exception;
  if (exception == null || typeof exception !== 'object') {
    return undefined;
  }
  const values = (exception as Record<string, unknown>).values;
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }
  const [first] = values;
  return first != null && typeof first === 'object'
    ? (first as Record<string, unknown>)
    : undefined;
}

/** True when the event already carries an app-set fingerprint. */
function hasFingerprint(event: Record<string, unknown>): boolean {
  const fingerprint = event.fingerprint;
  return Array.isArray(fingerprint) && fingerprint.length > 0;
}

/**
 * The longest exception message {@link fallbackFingerprint} reads.
 *
 * `beforeSend` runs on the JS thread, and an exception message is unbounded (a
 * server error body can be megabytes). A fingerprint only needs enough of the
 * message to name the defect, so the volatile-value patterns are applied to
 * this prefix rather than to the whole message; that bounds the work
 * regardless of the patterns' cost and keeps `beforeSend` off the critical
 * path.
 */
export const FINGERPRINT_MESSAGE_LIMIT = 512;

/**
 * The fallback fingerprint for an event that sets none: the exception class
 * plus its message with the volatile values removed and token-shaped runs
 * redacted. Sentry's default groups by the stack, whose absolute build path
 * differs per worktree, so one defect became one issue per worktree; this keeps
 * it one, while the class and message still separate different defects.
 */
function fallbackFingerprint(event: Record<string, unknown>): string[] | undefined {
  const exception = firstExceptionValue(event);
  if (exception === undefined) {
    return undefined;
  }
  const message = stringField(exception, 'value') ?? stringField(event, 'message');
  if (message === undefined || message.length === 0) {
    return undefined;
  }
  return [
    stringField(exception, 'type') ?? 'Error',
    redactString(stripVolatileValues(message.slice(0, FINGERPRINT_MESSAGE_LIMIT)), false),
  ];
}

/**
 * Scrub a Sentry event before it is sent.
 *
 * - Strips query strings from request URL and contexts.response URL.
 * - Deletes `user.email`, `user.username`, and `user.ip_address`.
 * - Redacts token-shaped runs (20+ base64url chars, or any `Bearer ` value) at
 *   any depth in `event.extra`, `event.tags`, the app's payload context
 *   ({@link NETWORK_BODY_CONTEXT}), and the exception-name context
 *   `extraErrorDataIntegration` attaches. A word-chain run stays only at an
 *   app-set identifier path (see {@link IDENTIFIER_PATHS}); anywhere else a
 *   word-chain secret is redacted on shape alone. Sentry's structured contexts
 *   are left intact: their identifiers trip the token heuristic without holding
 *   secrets.
 * - Gives an event with no fingerprint the fallback {@link fallbackFingerprint},
 *   so a volatile build path, host, or port inside the message or the stack
 *   cannot split one defect into many issues.
 */
export function scrubEvent<T>(event: T): T {
  try {
    if (event == null || typeof event !== 'object') {
      return event;
    }

    const e = event as Record<string, unknown>;

    // request.url
    if (e.request != null && typeof e.request === 'object') {
      const req = e.request as Record<string, unknown>;
      if ('url' in req) {
        req.url = stripQuery(req.url);
      }
    }

    // contexts.response (nested under contexts)
    if (e.contexts != null && typeof e.contexts === 'object') {
      const ctx = e.contexts as Record<string, unknown>;
      if (ctx.response != null && typeof ctx.response === 'object') {
        const resp = ctx.response as Record<string, unknown>;
        if ('url' in resp) {
          resp.url = stripQuery(resp.url);
        }
      }
      for (const name of redactedContextNames(e)) {
        if (name in ctx) {
          ctx[name] = redactValue(ctx[name], new WeakMap(), []);
        }
      }
    }

    // user identity
    if (e.user != null && typeof e.user === 'object') {
      const user = e.user as Record<string, unknown>;
      delete user.email;
      delete user.username;
      delete user.ip_address;
    }

    // extras and tags
    if ('extra' in e) {
      e.extra = redactTokens(e.extra as Record<string, unknown> | undefined, 'extra');
    }
    if ('tags' in e) {
      e.tags = redactTokens(e.tags as Record<string, unknown> | undefined, 'tags');
    }

    // Fingerprint fallback. Only fills a gap: an app-set fingerprint is kept.
    if (!hasFingerprint(e)) {
      const fallback = fallbackFingerprint(e);
      if (fallback !== undefined) {
        e.fingerprint = fallback;
      }
    }

    return event;
  } catch {
    return event;
  }
}

/**
 * Scrub a Sentry breadcrumb before it is attached.
 *
 * - Returns `null` for `console` breadcrumbs (they carry prompt/response text).
 * - Strips the query string from `breadcrumb.data.url`.
 * - Leaves navigation and fetch breadcrumbs otherwise intact.
 */
export function scrubBreadcrumb<T>(breadcrumb: T): T | null {
  try {
    if (breadcrumb == null || typeof breadcrumb !== 'object') {
      return breadcrumb;
    }

    const b = breadcrumb as Record<string, unknown>;

    if (b.category === 'console') {
      return null;
    }

    if (b.data != null && typeof b.data === 'object') {
      const data = b.data as Record<string, unknown>;
      if ('url' in data) {
        data.url = stripQuery(data.url);
      }
    }

    return breadcrumb;
  } catch {
    return breadcrumb;
  }
}
