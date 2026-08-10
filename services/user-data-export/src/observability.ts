type LogLevel = 'info' | 'warn' | 'error';

type ExportLogFields = Record<string, boolean | number | string | null | undefined>;

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

export function logExportEvent(level: LogLevel, event: string, fields: ExportLogFields = {}): void {
  const value = JSON.stringify({ event, service: 'user-data-export', ...fields });
  if (level === 'error') console.error(value);
  else if (level === 'warn') console.warn(value);
  else console.log(value);
}
