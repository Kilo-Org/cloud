import type { DeletionHandlerOutcome } from '@/lib/user/deletion-queue/deletion-types';

export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

export function classifyHttpStatus(status: number): DeletionHandlerOutcome {
  if (status === 429) {
    return { kind: 'rate_limited', retryAfterMs: 60_000 };
  }
  if (status === 401 || status === 403) {
    return { kind: 'needs_attention', errorCode: `http_${status}` };
  }
  if (status === 400 || status === 422) {
    return { kind: 'needs_attention', errorCode: `http_${status}` };
  }
  if (status === 404) {
    return { kind: 'needs_attention', errorCode: 'http_404' };
  }
  if (status === 408 || status === 425 || status >= 500) {
    return { kind: 'retry', errorCode: `http_${status}`, httpStatusClass: httpStatusClass(status) };
  }
  if (status === 409) {
    return { kind: 'needs_attention', errorCode: 'http_409_needs_reconcile' };
  }
  return { kind: 'needs_attention', errorCode: `http_${status}` };
}

export function httpStatusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export function classifyFetchFailure(error: unknown): DeletionHandlerOutcome {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { kind: 'retry', errorCode: 'timeout', httpStatusClass: 'timeout' };
  }
  if (error instanceof Error && /timeout|network|ECONNRESET|fetch failed/i.test(error.message)) {
    return { kind: 'retry', errorCode: 'connection_failure', httpStatusClass: 'network' };
  }
  return { kind: 'retry', errorCode: 'unknown_transport', httpStatusClass: 'network' };
}
