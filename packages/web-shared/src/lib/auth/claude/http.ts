import 'server-only';
import { setTimeout } from 'node:timers/promises';

/** Total fetch attempts, including the first one, before the last response is returned. */
export const CLAUDE_RETRY_MAX_ATTEMPTS = 3;
/** Base of the exponential backoff between attempts, in milliseconds. */
export const CLAUDE_RETRY_BASE_DELAY_MS = 200;
/** Largest Retry-After or backoff the helper sits through before returning the response. */
export const CLAUDE_RETRY_MAX_DELAY_MS = 2_000;

// Retry only explicit rejections, never a network failure after an inference
// request may already have been served. Each OAuth retry mints a fresh assertion.
export async function fetchClaudeWithRetry(
  url: string,
  init: () => Promise<RequestInit>,
  retryableStatus: (status: number) => boolean,
  signal?: AbortSignal
): Promise<Response> {
  for (let attempt = 1; attempt <= CLAUDE_RETRY_MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, { ...(await init()), signal, redirect: 'manual' });
    if (attempt === CLAUDE_RETRY_MAX_ATTEMPTS || !retryableStatus(response.status)) return response;
    const retryAfter = response.headers.get('retry-after');
    const delay =
      retryAfter === null
        ? CLAUDE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
        : /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now());
    // Return long Retry-After values to the caller rather than retrying early.
    if (!Number.isFinite(delay) || delay > CLAUDE_RETRY_MAX_DELAY_MS) return response;
    await response.body?.cancel();
    await setTimeout(delay, undefined, { signal });
  }
  // `CLAUDE_RETRY_MAX_ATTEMPTS` is at least 1, so the loop above always returns.
  throw new Error('fetchClaudeWithRetry requires CLAUDE_RETRY_MAX_ATTEMPTS to be at least 1');
}
