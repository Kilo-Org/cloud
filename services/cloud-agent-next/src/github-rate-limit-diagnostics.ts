export const GITHUB_RATE_LIMIT_DIAGNOSTIC_MAX_BODY_BYTES = 2 * 1024;
export const GITHUB_RATE_LIMIT_DIAGNOSTIC_BODY_DEADLINE_MS = 100;
const MAX_NUMERIC_HEADER_LENGTH = 16;
const MAX_RESOURCE_HEADER_LENGTH = 32;
const MAX_RETRY_AFTER_HEADER_LENGTH = 64;

const BODY_READ_TIMED_OUT = Symbol('github body read timed out');

const HTTP_DATE_RE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export type GitHubRateLimitBodySignal =
  | 'primary_limit'
  | 'secondary_limit'
  | 'abuse_detection'
  | 'too_many_requests'
  | 'unavailable'
  | 'none';

export type GitHubRateLimitQuotaClass =
  | 'primary_exhausted'
  | 'primary_signal'
  | 'secondary_or_abuse_signal'
  | 'unknown';

export type GitHubRateLimitDiagnostic = {
  upstreamStatus: 403 | 429;
  githubRateLimitLimit?: string;
  githubRateLimitRemaining?: string;
  githubRateLimitUsed?: string;
  githubRateLimitReset?: string;
  githubRateLimitResource?: string;
  githubRetryAfter?: string;
  quotaClass: GitHubRateLimitQuotaClass;
  bodySignal: GitHubRateLimitBodySignal;
};

type RateLimitHeaderValues = Omit<
  GitHubRateLimitDiagnostic,
  'upstreamStatus' | 'quotaClass' | 'bodySignal'
>;

function readHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value || undefined;
}

function readNonNegativeIntegerHeader(headers: Headers, name: string): string | undefined {
  const value = readHeader(headers, name);
  if (!value || value.length > MAX_NUMERIC_HEADER_LENGTH) return undefined;
  if (!new RegExp(`^(?:0|[1-9]\\d{0,${MAX_NUMERIC_HEADER_LENGTH - 1}})$`).test(value)) {
    return undefined;
  }
  return Number.isSafeInteger(Number(value)) ? value : undefined;
}

function readResourceHeader(headers: Headers): string | undefined {
  const value = readHeader(headers, 'x-ratelimit-resource');
  if (
    !value ||
    value.length > MAX_RESOURCE_HEADER_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function readRetryAfterHeader(headers: Headers): string | undefined {
  const value = readHeader(headers, 'retry-after');
  if (!value || value.length > MAX_RETRY_AFTER_HEADER_LENGTH) return undefined;
  if (/^(?:0|[1-9]\d{0,9})$/.test(value) || HTTP_DATE_RE.test(value)) return value;
  return undefined;
}

function readRateLimitHeaders(headers: Headers): RateLimitHeaderValues {
  const values: RateLimitHeaderValues = {};
  const limit = readNonNegativeIntegerHeader(headers, 'x-ratelimit-limit');
  const remaining = readNonNegativeIntegerHeader(headers, 'x-ratelimit-remaining');
  const used = readNonNegativeIntegerHeader(headers, 'x-ratelimit-used');
  const reset = readNonNegativeIntegerHeader(headers, 'x-ratelimit-reset');
  const resource = readResourceHeader(headers);
  const retryAfter = readRetryAfterHeader(headers);

  if (limit !== undefined) values.githubRateLimitLimit = limit;
  if (remaining !== undefined) values.githubRateLimitRemaining = remaining;
  if (used !== undefined) values.githubRateLimitUsed = used;
  if (reset !== undefined) values.githubRateLimitReset = reset;
  if (resource !== undefined) values.githubRateLimitResource = resource;
  if (retryAfter !== undefined) values.githubRetryAfter = retryAfter;
  return values;
}

/** Classifies known provider phrases without retaining or returning the body. */
export function classifyGitHubRateLimitBody(body: string): GitHubRateLimitBodySignal {
  const normalized = body.toLowerCase().replace(/\s+/g, ' ');

  if (/\bsecondary[ -]?rate[ -]?limit\b/.test(normalized)) return 'secondary_limit';
  if (/\babuse detection\b|\babuse[- ]?detected\b/.test(normalized)) {
    return 'abuse_detection';
  }
  if (
    /\b(?:api|primary)[ -]?rate[ -]?limit\b/.test(normalized) ||
    /\brate[ -]?limit(?: has been| is)? (?:exceeded|reached)\b/.test(normalized) ||
    /\b(?:exceeded|reached) (?:the )?(?:api|primary|rate[ -]?limit)\b/.test(normalized)
  ) {
    return 'primary_limit';
  }
  if (/\btoo many requests\b|\b429\b/.test(normalized)) return 'too_many_requests';
  if (/\bunavailable\b/.test(normalized)) return 'unavailable';
  return 'none';
}

function quotaClassFor(
  remaining: string | undefined,
  bodySignal: GitHubRateLimitBodySignal
): GitHubRateLimitQuotaClass {
  if (remaining !== undefined && Number(remaining) === 0) return 'primary_exhausted';
  if (bodySignal === 'primary_limit') return 'primary_signal';
  if (bodySignal === 'secondary_limit' || bodySignal === 'abuse_detection') {
    return 'secondary_or_abuse_signal';
  }
  return 'unknown';
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array> | typeof BODY_READ_TIMED_OUT> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<typeof BODY_READ_TIMED_OUT>(resolve => {
        timeout = setTimeout(() => resolve(BODY_READ_TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readBodySignal(response: Response): Promise<GitHubRateLimitBodySignal> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  const deadline = Date.now() + GITHUB_RATE_LIMIT_DIAGNOSTIC_BODY_DEADLINE_MS;

  try {
    const clone = response.clone();
    if (!clone.body) return 'none';
    reader = clone.body.getReader();

    while (bytesRead < GITHUB_RATE_LIMIT_DIAGNOSTIC_MAX_BODY_BYTES) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const result = await readWithDeadline(reader, remainingMs);
      if (result === BODY_READ_TIMED_OUT || result.done) break;
      if (!(result.value instanceof Uint8Array)) break;

      const bytesToKeep = Math.min(
        result.value.byteLength,
        GITHUB_RATE_LIMIT_DIAGNOSTIC_MAX_BODY_BYTES - bytesRead
      );
      if (bytesToKeep > 0) {
        // slice() copies the prefix so an oversized provider chunk is not retained.
        chunks.push(result.value.slice(0, bytesToKeep));
        bytesRead += bytesToKeep;
      }
      if (bytesToKeep < result.value.byteLength) break;
    }
  } catch {
    return 'none';
  } finally {
    if (reader) {
      try {
        // The clone's cancellation can wait on the untouched tee branch. Never await it.
        void reader.cancel().catch(() => undefined);
      } catch {
        // A diagnostic cancellation failure must not affect the upstream response.
      }
    }
  }

  if (chunks.length === 0) return 'none';
  const bodyBytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return classifyGitHubRateLimitBody(new TextDecoder().decode(bodyBytes));
}

export async function inspectGitHubRateLimitResponse(
  response: Response
): Promise<GitHubRateLimitDiagnostic | undefined> {
  if (response.status !== 403 && response.status !== 429) return undefined;

  const headers = readRateLimitHeaders(response.headers);
  let bodySignal: GitHubRateLimitBodySignal = 'none';
  try {
    bodySignal = await readBodySignal(response);
  } catch {
    // Keep the response boundary best-effort if the runtime rejects inspection.
  }

  return {
    upstreamStatus: response.status,
    ...headers,
    quotaClass: quotaClassFor(headers.githubRateLimitRemaining, bodySignal),
    bodySignal,
  };
}
