import { describe, expect, it } from 'vitest';
import { uploadGzipStream } from './gzip';
import { isAllowedWebCallbackUrl, redirectTargetHost } from './worker';

describe('uploadGzipStream', () => {
  it('flushes full parts periodically and one short final part', async () => {
    const values: Uint8Array[] = [];
    const parts = await uploadGzipStream({
      stream: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])]).stream(),
      partBytes: 4,
      uploadPart: async (_partNumber, value) => {
        values.push(value.slice());
        return { etag: `etag-${values.length}` };
      },
    });

    expect(parts).toEqual([
      { partNumber: 1, etag: 'etag-1', sizeBytes: 4 },
      { partNumber: 2, etag: 'etag-2', sizeBytes: 4 },
      { partNumber: 3, etag: 'etag-3', sizeBytes: 1 },
    ]);
    expect(values).toEqual([
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      new Uint8Array([9]),
    ]);
  });

  it('allows HTTPS and loopback HTTP notification callbacks only', () => {
    expect(isAllowedWebCallbackUrl('https://api.kilo.ai')).toBe(true);
    expect(isAllowedWebCallbackUrl('http://localhost:3000')).toBe(true);
    expect(isAllowedWebCallbackUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedWebCallbackUrl('https://example.com')).toBe(false);
    expect(isAllowedWebCallbackUrl('https://app.kilo.ai')).toBe(false);
    expect(isAllowedWebCallbackUrl('http://api.kilo.ai')).toBe(false);
    expect(isAllowedWebCallbackUrl('not-a-url')).toBe(false);
  });

  it('reports only the redirect target host, never its path or query', () => {
    const requestUrl = new URL('https://api.kilo.ai/api/internal/user-data-exports/ready');

    const crossOrigin = new Response(null, {
      status: 302,
      headers: { location: 'https://login.kilo.ai/auth?token=secret-value' },
    });
    expect(redirectTargetHost(crossOrigin, requestUrl)).toBe('login.kilo.ai');

    const relative = new Response(null, { status: 308, headers: { location: '/login?next=x' } });
    expect(redirectTargetHost(relative, requestUrl)).toBe('api.kilo.ai');

    const missing = new Response(null, { status: 302 });
    expect(redirectTargetHost(missing, requestUrl)).toBe('unknown');
  });
});
