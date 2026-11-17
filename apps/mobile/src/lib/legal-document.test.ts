import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadLegalDocument } from './legal-document';

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));

const originalFetch = globalThis.fetch;

function respondWith(response: Response | Error): void {
  globalThis.fetch = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
  );
}

const signal = new AbortController().signal;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('loadLegalDocument', () => {
  it('reads the document from the app API', async () => {
    respondWith(Response.json({ html: '<h1>Terms</h1>' }));

    await expect(loadLegalDocument('terms', signal)).resolves.toEqual({
      kind: 'loaded',
      html: '<h1>Terms</h1>',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.example.com/api/legal/terms', {
      signal: expect.any(AbortSignal),
    });
  });

  it('stops waiting for a stalled request and reports it as retryable', async () => {
    vi.useFakeTimers();
    const stalled = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      init?.signal?.addEventListener('abort', () => {
        stalled.reject(new Error('aborted'));
      });
      return stalled.promise;
    });

    const pending = loadLegalDocument('privacy', signal);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toEqual({ kind: 'failed', failure: 'retryable' });
  });

  it('cancels the request when the screen abandons the attempt', async () => {
    const attempt = new AbortController();
    const stalled = Promise.withResolvers<Response>();
    const carried: AbortSignal[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if (init?.signal) {
        carried.push(init.signal);
        init.signal.addEventListener('abort', () => {
          stalled.reject(new Error('aborted'));
        });
      }
      return stalled.promise;
    });

    const pending = loadLegalDocument('terms', attempt.signal);
    attempt.abort();

    await expect(pending).resolves.toEqual({ kind: 'failed', failure: 'retryable' });
    expect(carried).toHaveLength(1);
    expect(carried[0]?.aborted).toBe(true);
  });

  it('treats an unreachable API as retryable', async () => {
    respondWith(new Error('network unavailable'));

    await expect(loadLegalDocument('privacy', signal)).resolves.toEqual({
      kind: 'failed',
      failure: 'retryable',
    });
  });

  it('treats a server-side failure as retryable', async () => {
    respondWith(new Response('{}', { status: 502 }));

    await expect(loadLegalDocument('privacy', signal)).resolves.toEqual({
      kind: 'failed',
      failure: 'retryable',
    });
  });

  it('treats a document the server does not serve as unavailable', async () => {
    respondWith(new Response('{}', { status: 404 }));

    await expect(loadLegalDocument('privacy', signal)).resolves.toEqual({
      kind: 'failed',
      failure: 'unavailable',
    });
  });

  it('treats an unreadable body as retryable', async () => {
    respondWith(new Response('not json', { status: 200 }));

    await expect(loadLegalDocument('terms', signal)).resolves.toEqual({
      kind: 'failed',
      failure: 'retryable',
    });
  });

  it('treats an empty document as retryable', async () => {
    respondWith(Response.json({ html: '   ' }));

    await expect(loadLegalDocument('terms', signal)).resolves.toEqual({
      kind: 'failed',
      failure: 'retryable',
    });
  });
});
