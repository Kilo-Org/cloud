import { beforeEach, describe, expect, test } from '@jest/globals';
import * as z from 'zod';
import { createWorkerAdminFetch, WORKER_ADMIN_TIMEOUT_MS } from './worker-admin-fetch';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const unconfiguredError = 'Worker is not configured';
const responseSchema = z.object({ ok: z.literal(true) });

function configuredFetch(workerUrl: string | undefined) {
  return createWorkerAdminFetch({ workerUrl, unconfiguredError });
}

describe('createWorkerAdminFetch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  test('sends an admin request to an https worker endpoint', async () => {
    const fetchAdmin = configuredFetch('https://worker.example.com');

    await expect(fetchAdmin('/admin/x', { method: 'GET' }, responseSchema)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });

    expect(mockFetch).toHaveBeenCalledWith('https://worker.example.com/admin/x', {
      method: 'GET',
      signal: expect.any(AbortSignal),
      headers: { authorization: 'Bearer test-internal-secret' },
    });
  });

  test('sends an admin request to an https worker endpoint with a trailing slash', async () => {
    const fetchAdmin = configuredFetch('https://worker.example.com/');

    await expect(fetchAdmin('/admin/x', { method: 'GET' }, responseSchema)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });

    expect(mockFetch).toHaveBeenCalledWith('https://worker.example.com/admin/x', {
      method: 'GET',
      signal: expect.any(AbortSignal),
      headers: { authorization: 'Bearer test-internal-secret' },
    });
  });

  test('sends an admin request to a loopback http worker endpoint', async () => {
    const fetchAdmin = configuredFetch('http://127.0.0.1:8799');

    await expect(fetchAdmin('/admin/x', { method: 'GET' }, responseSchema)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });

    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:8799/admin/x', {
      method: 'GET',
      signal: expect.any(AbortSignal),
      headers: { authorization: 'Bearer test-internal-secret' },
    });
  });

  test.each(['http://worker.example.com', 'ftp://worker.example.com', undefined])(
    'keeps an endpoint outside the rule unconfigured',
    async workerUrl => {
      const fetchAdmin = configuredFetch(workerUrl);

      await expect(fetchAdmin('/admin/x', { method: 'GET' }, responseSchema)).resolves.toEqual({
        status: 500,
        body: { error: unconfiguredError },
      });

      expect(mockFetch).not.toHaveBeenCalled();
    }
  );

  test('keeps the caller signal instead of the default deadline', async () => {
    const fetchAdmin = configuredFetch('https://worker.example.com');
    const signal = new AbortController().signal;

    await fetchAdmin('/admin/x', { method: 'GET', signal }, responseSchema);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://worker.example.com/admin/x',
      expect.objectContaining({ signal })
    );
  });

  test('passes the worker error message through with its status', async () => {
    mockFetch.mockResolvedValue(
      Response.json(
        { error: 'Internal server error', message: 'D1 DB is overloaded' },
        { status: 500 }
      )
    );
    const fetchAdmin = configuredFetch('https://worker.example.com');

    await expect(fetchAdmin('/admin/x', { method: 'GET' }, responseSchema)).resolves.toEqual({
      status: 500,
      body: { error: 'Internal server error', message: 'D1 DB is overloaded' },
    });
  });

  test('reports a non-JSON error body by its status', async () => {
    mockFetch.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    const fetchAdmin = configuredFetch('https://worker.example.com');

    await expect(fetchAdmin('/admin/x', { method: 'GET' }, responseSchema)).resolves.toEqual({
      status: 502,
      body: { error: 'Request failed: 502' },
    });
  });

  test('reports a worker that misses the default deadline as a 504', async () => {
    const expired = AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(expired);
    mockFetch.mockRejectedValue(expired.reason);
    const fetchAdmin = configuredFetch('https://worker.example.com');

    await expect(fetchAdmin('/admin/x', { method: 'GET' }, responseSchema)).resolves.toEqual({
      status: 504,
      body: { error: 'Worker request timed out' },
    });
    expect(timeout).toHaveBeenCalledWith(WORKER_ADMIN_TIMEOUT_MS);
    timeout.mockRestore();
  });

  test.each([200, 500])(
    'reports a %i response whose body stalls past the default deadline as a 504',
    async status => {
      const deadline = new AbortController();
      const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
      const reading = Promise.withResolvers<void>();
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          deadline.signal.addEventListener('abort', () => stream.error(deadline.signal.reason));
        },
        pull() {
          reading.resolve();
        },
      });
      mockFetch.mockResolvedValue(new Response(body, { status }));
      const fetchAdmin = configuredFetch('https://worker.example.com');

      const result = fetchAdmin('/admin/x', { method: 'GET' }, responseSchema);
      await reading.promise;
      deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));

      await expect(result).resolves.toEqual({
        status: 504,
        body: { error: 'Worker request timed out' },
      });
      timeout.mockRestore();
    }
  );

  test('rethrows when the caller signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch.mockRejectedValue(controller.signal.reason);
    const fetchAdmin = configuredFetch('https://worker.example.com');

    await expect(
      fetchAdmin('/admin/x', { method: 'GET', signal: controller.signal }, responseSchema)
    ).rejects.toBe(controller.signal.reason);
  });
});
