/**
 * The nested cause of a failed D1 statement, for structured logs.
 *
 * Drizzle wraps a D1 failure in an error whose message is the statement and its bound
 * parameters (`Failed query: … params: …`); the driver's own diagnostic is only on
 * `cause`. Without it an operator sees "Failed query: update …" and cannot tell an
 * overload from a missing table, which is exactly what made one production incident
 * ambiguous.
 *
 * Only the cause's first line is reported, cut at the parameters tail and capped, so a
 * log line never carries bound values.
 */
const MAX_CAUSE_LENGTH = 200;

export function d1ErrorCause(error: unknown): { cause?: string } {
  const nested = (error as { cause?: unknown } | null | undefined)?.cause;
  if (nested === undefined || nested === null) return {};
  const text = nested instanceof Error ? nested.message : String(nested);
  const firstLine = text.split('\n')[0] ?? '';
  const withoutParams = firstLine.split(' params:')[0] ?? '';
  const cause = withoutParams.trim().slice(0, MAX_CAUSE_LENGTH);
  return cause.length > 0 ? { cause } : {};
}
