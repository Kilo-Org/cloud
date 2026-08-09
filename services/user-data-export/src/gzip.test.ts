import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gzipMember, gzipPaddingMember, uploadGzipStream } from './gzip';
import { exportArtifact, isAllowedWebCallbackUrl, redirectTargetHost } from './worker';

describe('gzip export members', () => {
  it('concatenates independently compressed JSONL members into one gzip stream', async () => {
    const header = await gzipMember('{"type":"header"}\n');
    const record = await gzipMember('{"value":"hello"}\n');
    const padding = await gzipPaddingMember(1024);
    const archive = Buffer.concat([header, record, padding]);

    expect(gunzipSync(archive).toString()).toBe('{"type":"header"}\n{"value":"hello"}\n');
    expect(padding.byteLength).toBe(1024);
  });

  it('streams a smaller final part without padding', async () => {
    const parts: Uint8Array[] = [];
    const uploaded = await uploadGzipStream({
      stream: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7])]).stream(),
      partBytes: 8,
      startPartNumber: 3,
      isFinal: () => true,
      uploadPart: async (_partNumber, value) => {
        parts.push(value.slice());
        return { etag: `etag-${parts.length}` };
      },
    });

    expect(uploaded).toEqual([{ partNumber: 3, etag: 'etag-1', sizeBytes: 7 }]);
    expect(parts[0]).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
  });

  it('pads non-final output to uniform parts without decoded bytes', async () => {
    const payload = '{"value":"hello"}\n';
    const compressed = await gzipMember(payload);
    const parts: Uint8Array[] = [];
    await uploadGzipStream({
      stream: new Blob([compressed]).stream(),
      partBytes: 64,
      startPartNumber: 1,
      isFinal: () => false,
      uploadPart: async (_partNumber, value) => {
        parts.push(value.slice());
        return { etag: `etag-${parts.length}` };
      },
    });

    expect(parts.every(part => part.byteLength === 64)).toBe(true);
    expect(gunzipSync(Buffer.concat(parts)).toString()).toBe(payload);
  });

  it('stores a gzip archive without HTTP content encoding', () => {
    expect(exportArtifact).toEqual({
      contentDisposition: 'attachment; filename="kilo-data-export.jsonl.gz"',
      contentType: 'application/gzip',
      partBytes: 5 * 1024 * 1024,
    });
    expect(exportArtifact).not.toHaveProperty('contentEncoding');
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
