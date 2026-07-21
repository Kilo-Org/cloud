import 'server-only';

export type GitHubPrReviewErrorCode =
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'TOO_MANY_REQUESTS'
  | 'FORBIDDEN'
  | 'BAD_REQUEST'
  | 'CONFLICT'
  | 'BAD_GATEWAY';

export type ClassifiedGitHubError = {
  code: GitHubPrReviewErrorCode;
  message: string;
  retryAfterEpochMs?: number;
};

type HeaderRecord = Record<string, string | string[] | undefined> | undefined;

function getHeader(headers: HeaderRecord, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct)) return direct[0];
  const lower = headers[name.toLowerCase()];
  if (typeof lower === 'string') return lower;
  if (Array.isArray(lower)) return lower[0];
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

type OctokitHttpError = {
  status: number;
  message: string;
  response?: { headers?: HeaderRecord; data?: unknown };
};

function isOctokitHttpError(error: unknown): error is OctokitHttpError {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number';
}

function isRateLimitHeaders(headers: HeaderRecord): boolean {
  const remaining = getHeader(headers, 'x-ratelimit-remaining');
  if (remaining === '0') return true;
  return Boolean(getHeader(headers, 'retry-after'));
}

// Absolute epoch (ms) at which the caller may retry, derived purely from the
// headers plus the supplied `now` (so the classifier stays deterministic and
// testable). `x-ratelimit-reset` is an absolute epoch in seconds; `retry-after`
// is either a delta in seconds (relative to `now`) or an HTTP date.
function retryAfterEpochMs(headers: HeaderRecord, now: number): number | undefined {
  const reset = getHeader(headers, 'x-ratelimit-reset');
  if (reset) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  const retryAfter = getHeader(headers, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return now + seconds * 1000;
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return date;
    }
  }
  return undefined;
}

function rateLimitMessage(headers: HeaderRecord, now: number): string {
  const resetAt = retryAfterEpochMs(headers, now);
  if (resetAt === undefined) {
    return 'GitHub rate limit reached. Please try again later.';
  }
  const minutes = Math.max(1, Math.round((resetAt - now) / 60_000));
  return `GitHub rate limit reached. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

const NOT_FOUND_MESSAGE =
  "PR not found, you don't have access, or the Kilo GitHub App isn't installed for this repository";
const PRECONDITION_FAILED_MESSAGE = 'GitHub connection is no longer valid — reconnect';
const FALLBACK_FORBIDDEN = 'You do not have permission to perform this action on this PR';
const FALLBACK_BAD_REQUEST = 'GitHub rejected this request';
const FALLBACK_CONFLICT = 'GitHub reported a conflict for this PR';
const FALLBACK_BAD_GATEWAY = 'GitHub returned an unexpected error';

export function classifyGitHubHttpError(
  error: unknown,
  now: number = Date.now()
): ClassifiedGitHubError {
  if (!isOctokitHttpError(error)) {
    return { code: 'BAD_GATEWAY', message: FALLBACK_BAD_GATEWAY };
  }
  const status = error.status;
  const message = getErrorMessage(error) || FALLBACK_BAD_GATEWAY;
  const headers = error.response?.headers;

  if (status === 404) {
    return { code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE };
  }
  if (status === 401) {
    return { code: 'PRECONDITION_FAILED', message: PRECONDITION_FAILED_MESSAGE };
  }
  if (status === 422) {
    return { code: 'BAD_REQUEST', message: message || FALLBACK_BAD_REQUEST };
  }
  if (status === 405 || status === 409) {
    return { code: 'CONFLICT', message: message || FALLBACK_CONFLICT };
  }
  if (status === 403 || status === 429) {
    if (status === 429 || (headers && isRateLimitHeaders(headers))) {
      return {
        code: 'TOO_MANY_REQUESTS',
        message: rateLimitMessage(headers, now),
        retryAfterEpochMs: retryAfterEpochMs(headers, now),
      };
    }
    return { code: 'FORBIDDEN', message: message || FALLBACK_FORBIDDEN };
  }
  if (status >= 500) {
    return { code: 'BAD_GATEWAY', message: message || FALLBACK_BAD_GATEWAY };
  }
  if (status >= 400) {
    return { code: 'BAD_REQUEST', message: message || FALLBACK_BAD_REQUEST };
  }
  return { code: 'BAD_GATEWAY', message: FALLBACK_BAD_GATEWAY };
}

export type GraphQlErrorEntry = { type?: string; message?: string };

function classifyGraphQlEntry(entry: GraphQlErrorEntry, now: number): ClassifiedGitHubError {
  const type = (entry.type ?? '').toUpperCase();
  const message = entry.message?.trim();
  if (type === 'NOT_FOUND') {
    return { code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE };
  }
  if (type === 'FORBIDDEN') {
    return { code: 'FORBIDDEN', message: message || FALLBACK_FORBIDDEN };
  }
  if (type === 'RATE_LIMITED' || type === 'SECONDARY_RATE_LIMIT' || type === 'ABUSE_DETECTION') {
    return { code: 'TOO_MANY_REQUESTS', message: rateLimitMessage(undefined, now) };
  }
  if (message) {
    return { code: 'BAD_GATEWAY', message };
  }
  return { code: 'BAD_GATEWAY', message: FALLBACK_BAD_GATEWAY };
}

export function classifyGitHubGraphQlErrors(
  errors: ReadonlyArray<GraphQlErrorEntry> | undefined,
  now: number = Date.now()
): ClassifiedGitHubError | null {
  if (!errors || errors.length === 0) return null;
  const first = errors[0];
  if (!first) return null;
  return classifyGraphQlEntry(first, now);
}
