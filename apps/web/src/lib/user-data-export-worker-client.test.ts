jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-secret',
  USER_DATA_EXPORT_WORKER_URL: 'http://127.0.0.1:8787',
}));

import { __test__ } from '@/lib/user-data-export-worker-client';

describe('user data export Worker client', () => {
  it.each([
    ['http://127.0.0.1:8787', true],
    ['http://localhost:8787', true],
    ['http://[::1]:8787', true],
    ['https://user-data-export.kilosessions.ai', true],
    ['https://example.com', false],
    ['https://user-data-export.kiloapps.io', false],
    ['http://user-data-export.kilosessions.ai', false],
    ['not a url', false],
  ])('allows only configured safe Worker origins: %s', (value, allowed) => {
    expect(__test__.exportWorkerUrl(value) !== null).toBe(allowed);
  });

  it('uses the internal API secret, timeout, and refuses redirects', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const response = await __test__.postExportWorker(
      '/internal/exports/dispatch',
      { exportId: 'id' },
      fetchImpl
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8787/internal/exports/dispatch'),
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          'x-internal-api-key': 'test-secret',
        }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(response?.status).toBe(202);
  });

  it('returns an unavailable result when the Worker defers signing', async () => {
    const response = await __test__.postExportWorker(
      '/internal/exports/download',
      { exportId: 'id' },
      jest.fn().mockResolvedValue(new Response(null, { status: 501 }))
    );
    expect(response?.status).toBe(501);
  });
});
