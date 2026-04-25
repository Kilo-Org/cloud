import { describe, expect, it } from 'vitest';
import { FetchTimeoutError, fetchWithTimeout } from './fetch-with-timeout';

describe('fetchWithTimeout', () => {
  it('returns the response when the upstream resolves in time', async () => {
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as typeof fetch;

    const res = await fetchWithTimeout('https://example.test/', { method: 'GET' }, 1000, fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('throws FetchTimeoutError and aborts the upstream when the timeout expires', async () => {
    let observedAborted = false;
    const fetchImpl = ((_url: string | URL, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          observedAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as typeof fetch;

    await expect(
      fetchWithTimeout('https://example.test/', { method: 'GET' }, 5, fetchImpl)
    ).rejects.toBeInstanceOf(FetchTimeoutError);
    expect(observedAborted).toBe(true);
  });

  it("propagates the caller's abort signal without converting it to FetchTimeoutError", async () => {
    const callerController = new AbortController();
    const fetchImpl = ((_url: string | URL, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as typeof fetch;

    const p = fetchWithTimeout(
      'https://example.test/',
      { method: 'GET', signal: callerController.signal },
      10_000,
      fetchImpl
    );
    callerController.abort();
    await expect(p).rejects.toSatisfy(err => {
      return !(err instanceof FetchTimeoutError);
    });
  });

  it('rethrows non-abort errors unchanged', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    await expect(
      fetchWithTimeout('https://example.test/', { method: 'GET' }, 1000, fetchImpl)
    ).rejects.toThrow('ECONNREFUSED');
  });
});
