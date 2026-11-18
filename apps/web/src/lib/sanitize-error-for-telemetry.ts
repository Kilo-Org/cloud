const MAX_CAUSE_DEPTH = 5;
const REDACTED = '[redacted]';

/**
 * The subset of a failed error that may reach telemetry: what happened, where,
 * and the database diagnostics Sentry groups on. Every other property is
 * dropped rather than copied, so a store SDK error cannot carry its request
 * config or response body along.
 */
type SanitizedError = Error & {
  code?: string;
  query?: string;
  params?: unknown[];
};

function redact(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

function sanitize(error: unknown, secrets: readonly string[], depth: number): SanitizedError {
  if (!(error instanceof Error)) {
    const message = typeof error === 'string' && error.length > 0 ? error : 'Unknown error';
    return new Error(redact(message, secrets));
  }

  const message = redact(error.message, secrets);
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const query = 'query' in error && typeof error.query === 'string' ? error.query : undefined;
  const params = 'params' in error && Array.isArray(error.params) ? error.params : undefined;
  const cause = 'cause' in error ? error.cause : undefined;
  // A Drizzle wrapper's message *is* the query and its bound values, so it is
  // rebuilt from the parts instead of trusted: the SQL is placeholders, and the
  // values are replaced with their count.
  const isQueryError = query !== undefined && params !== undefined;

  const safe: SanitizedError = new Error(
    isQueryError ? `Failed query: ${redact(query, secrets)}\nparams: ${REDACTED}` : message,
    {
      cause:
        depth < MAX_CAUSE_DEPTH && cause !== undefined && cause !== null
          ? sanitize(cause, secrets, depth + 1)
          : undefined,
    }
  );
  safe.name = redact(error.name, secrets);
  if (typeof error.stack === 'string') {
    // A stack repeats the message ahead of its frames, and a Drizzle message
    // spans two lines (the query, then `params: …`), so only the frames survive
    // and the header is rebuilt from the sanitized message.
    const framesAt = error.stack.search(/\n\s*at /);
    const frames = framesAt === -1 ? '' : error.stack.slice(framesAt);
    safe.stack = redact(`${safe.name}: ${safe.message}${frames}`, secrets);
  }
  // A SQLSTATE (or an SDK error code) is diagnostics, not a credential.
  if (code !== undefined) {
    safe.code = redact(code, secrets);
  }
  if (isQueryError) {
    safe.query = redact(query, secrets);
    // Sentry's beforeSend reads `params` only to recognize a Drizzle wrapper,
    // so the count is kept and the values are not.
    safe.params = params.map(() => REDACTED);
  }

  return safe;
}

/**
 * A copy of `error` that is safe to hand to Sentry.
 *
 * An error raised while handling a store purchase is built from the request it
 * failed on, so it can carry a credential the store issued: a
 * `DrizzleQueryError` embeds every bound parameter in its message, and a Google
 * API error retains the request that names the purchase token in its URL. Only
 * the fields that describe the failure survive — name, message, stack, code,
 * the failed query, and the sanitized `cause` chain — every known secret is
 * replaced, and the original object is never retained. Keeping `query` and
 * `params` present preserves the Sentry `beforeSend` rewrite that groups
 * Drizzle failures by their database cause.
 */
export function sanitizeErrorForTelemetry(error: unknown, secrets: readonly string[] = []): Error {
  const usableSecrets = secrets.filter(secret => typeof secret === 'string' && secret.length > 0);
  return sanitize(error, usableSecrets, 0);
}
