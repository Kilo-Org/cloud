import 'server-only';
import { setTimeout } from 'node:timers/promises';

// Retry only explicit rejections, never a network failure after an inference
// request may already have been served. Each OAuth retry mints a fresh assertion.
export async function fetchClaudeWithRetry(
  url: string,
  init: () => Promise<RequestInit>,
  retryableStatus: (status: number) => boolean,
  signal?: AbortSignal
) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...(await init()), signal, redirect: 'manual' });
    if (attempt === 2 || !retryableStatus(response.status)) return response;
    const retryAfter = response.headers.get('retry-after');
    const delay =
      retryAfter === null
        ? 200 * 2 ** attempt
        : /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now());
    // Return long Retry-After values to the caller rather than retrying early.
    if (!Number.isFinite(delay) || delay > 2000) return response;
    await response.body?.cancel();
    await setTimeout(delay, undefined, { signal });
  }
}
