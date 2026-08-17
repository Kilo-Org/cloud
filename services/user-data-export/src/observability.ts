import { tracing } from 'cloudflare:workers';

type LogLevel = 'info' | 'warn' | 'error';

export type ExportFields = Record<string, boolean | number | string | null | undefined>;

/**
 * The subset of the runtime span we rely on.
 *
 * Declared locally rather than reusing the ambient `Span` class so call sites do not
 * depend on a platform type whose surface is still changing during the tracing beta,
 * and so the unit-test stub for `cloudflare:workers` stays trivially typed.
 */
export type ExportSpan = {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: boolean | number | string): void;
};

/**
 * Run `callback` inside a custom span named `name`, tagged with `fields`.
 *
 * Cloudflare auto-instruments fetch, R2, and queue operations, but not Hyperdrive:
 * `pg` reaches Postgres over a raw TCP socket, so every query this service makes is
 * invisible to tracing unless we wrap it ourselves. That covers the bulk of the work
 * in an export, which is why the spans below exist.
 *
 * Spans nest automatically via async context, so a span opened here becomes a child of
 * whichever span is already active and the parent covers any awaited work inside it.
 *
 * `fields` must stay free of personal data for the same reason `logExportEvent` fields
 * do: attributes are exported to the traces destination. Identifiers that describe the
 * job (export id, generation, source name) are fine; user ids, row contents, SQL text,
 * and cursor values are not.
 */
export function withSpan<T>(
  name: string,
  fields: ExportFields,
  callback: (span: ExportSpan) => T
): T {
  return tracing.enterSpan(name, span => {
    setSpanFields(span, fields);
    return callback(span);
  });
}

/**
 * Copy `fields` onto a span, skipping empty values.
 *
 * `setAttribute` treats `undefined` as a no-op but rejects `null`, which our field
 * records use freely (for example a not-yet-resolved `source`), so both are dropped.
 */
export function setSpanFields(span: ExportSpan, fields: ExportFields): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) span.setAttribute(key, value);
  }
}

export function safeError(error: unknown): { errorName: string; errorCode?: string | number } {
  if (!(error instanceof Error)) return { errorName: 'NonErrorThrow' };
  const code = (error as Error & { code?: unknown }).code;
  const errorName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error';
  const errorCode =
    typeof code === 'number'
      ? code
      : typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)
        ? code
        : undefined;
  return {
    errorName,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export type FetchFailureReason = 'timeout' | 'aborted' | 'redirect' | 'connection' | 'unknown';

/**
 * Classify a thrown `fetch()` failure into a fixed, non-sensitive reason.
 *
 * Only enumerated literals are returned; the original error message (which can
 * contain URLs, query text, or secrets) is never propagated. This lets us tell
 * apart the common Worker subrequest failures — a disallowed redirect (`redirect:
 * 'error'`), an `AbortSignal.timeout`, or a dropped connection — which
 * `safeError` alone flattens into an indistinguishable `TypeError`.
 */
export function classifyFetchFailure(error: unknown): FetchFailureReason {
  if (error instanceof DOMException) {
    if (error.name === 'TimeoutError') return 'timeout';
    if (error.name === 'AbortError') return 'aborted';
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('redirect')) return 'redirect';
  if (
    message.includes('network') ||
    message.includes('connection') ||
    message.includes('reset') ||
    message.includes('fetch failed') ||
    message.includes('failed to fetch')
  ) {
    return 'connection';
  }
  return 'unknown';
}

export function logExportEvent(level: LogLevel, event: string, fields: ExportFields = {}): void {
  const value = JSON.stringify({ event, service: 'user-data-export', ...fields });
  if (level === 'error') console.error(value);
  else if (level === 'warn') console.warn(value);
  else console.log(value);
}
