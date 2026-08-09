jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-secret',
  NEXTAUTH_SECRET: 'test-nextauth-secret',
  USER_DATA_EXPORT_WORKER_URL: 'http://127.0.0.1:8787',
}));

import jwt from 'jsonwebtoken';
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

  it('uses the internal API secret plus a five-minute audience-bound user assertion', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const response = await __test__.postExportWorker(
      '/internal/exports/dispatch',
      'user-id',
      { exportId: 'id' },
      fetchImpl
    );

    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    const authorization = new Headers(request?.headers).get('authorization');
    expect(authorization).toMatch(/^Bearer /);
    const decoded = jwt.decode(authorization?.slice(7) ?? '') as jwt.JwtPayload;
    expect(decoded.kiloUserId).toBe('user-id');
    expect(decoded.aud).toBe('user-data-export');
    expect(decoded.exp! - decoded.iat!).toBe(300);
    expect(JSON.parse(String(request?.body))).toEqual({ exportId: 'id' });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8787/internal/exports/dispatch'),
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer /),
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
      'user-id',
      { exportId: 'id' },
      jest.fn().mockResolvedValue(new Response(null, { status: 501 }))
    );
    expect(response?.status).toBe(501);
  });
});
