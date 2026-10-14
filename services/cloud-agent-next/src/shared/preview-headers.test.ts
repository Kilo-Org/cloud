import { describe, expect, it } from 'vitest';
import {
  PREVIEW_COOKIE_NAME,
  PREVIEW_HOST_COOKIE_NAME,
  filterPreviewRequestHeaders,
  previewCookieName,
  rewritePreviewLocation,
  sanitizePreviewResponseHeaders,
  type PreviewHeader,
} from './preview-headers.js';

function names(headers: PreviewHeader[]): string[] {
  return headers.map(header => header.name.toLowerCase());
}

describe('previewCookieName', () => {
  it('uses the host-bound cookie on https and the plain one on http', () => {
    expect(previewCookieName(true)).toBe(PREVIEW_HOST_COOKIE_NAME);
    expect(previewCookieName(false)).toBe(PREVIEW_COOKIE_NAME);
  });
});

describe('filterPreviewRequestHeaders', () => {
  it('drops proxy, platform, authentication and preview-marker headers', () => {
    const filtered = filterPreviewRequestHeaders(
      [
        { name: 'Authorization', value: 'Bearer secret' },
        { name: 'Host', value: 'evil.example' },
        { name: 'Connection', value: 'keep-alive' },
        { name: 'Content-Length', value: '12' },
        { name: 'Keep-Alive', value: 'timeout=5' },
        { name: 'Proxy-Authorization', value: 'x' },
        { name: 'Te', value: 'trailers' },
        { name: 'Trailer', value: 'x' },
        { name: 'Transfer-Encoding', value: 'chunked' },
        { name: 'X-Kilo-Preview-Port', value: '8000' },
        { name: 'X-Kilo-Preview-Allocation', value: 'ref' },
        { name: 'X-Kilo-Facade-Auth-Token', value: 't' },
        { name: 'Forwarded', value: 'for=1.2.3.4' },
        { name: 'X-Forwarded-For', value: '1.2.3.4' },
        { name: 'CF-Ray', value: 'abc' },
        { name: 'True-Client-IP', value: '1.2.3.4' },
        { name: 'X-Real-IP', value: '1.2.3.4' },
        { name: 'CDN-Loop', value: 'cloudflare' },
        { name: 'Referer', value: 'https://evil.example' },
        { name: 'Accept-Encoding', value: 'gzip' },
        { name: 'Accept', value: 'text/html' },
      ],
      { websocket: false }
    );
    expect(filtered).toEqual([{ name: 'Accept', value: 'text/html' }]);
  });

  it('preserves upgrade, connection and sec-websocket headers only for a WebSocket', () => {
    const pairs: PreviewHeader[] = [
      { name: 'Connection', value: 'Upgrade' },
      { name: 'Upgrade', value: 'websocket' },
      { name: 'Sec-WebSocket-Key', value: 'k' },
      { name: 'Sec-WebSocket-Version', value: '13' },
      { name: 'Sec-WebSocket-Protocol', value: 'chat' },
    ];
    expect(names(filterPreviewRequestHeaders(pairs, { websocket: true }))).toEqual([
      'connection',
      'upgrade',
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-protocol',
    ]);
    expect(filterPreviewRequestHeaders(pairs, { websocket: false })).toEqual([]);
  });

  it('parses Cookie and drops both preview cookie names while keeping the rest', () => {
    const filtered = filterPreviewRequestHeaders(
      [
        { name: 'Cookie', value: `${PREVIEW_COOKIE_NAME}=token; keep=1` },
        { name: 'Cookie', value: `${PREVIEW_HOST_COOKIE_NAME}=token; theme=dark` },
        { name: 'X-Test', value: 'yes' },
      ],
      { websocket: false }
    );
    expect(filtered).toContainEqual({ name: 'Cookie', value: 'keep=1; theme=dark' });
    expect(filtered).toContainEqual({ name: 'X-Test', value: 'yes' });
    expect(filtered).toHaveLength(2);
  });

  it('omits the Cookie header entirely when only preview cookies were sent', () => {
    const filtered = filterPreviewRequestHeaders(
      [{ name: 'Cookie', value: `${PREVIEW_HOST_COOKIE_NAME}=token` }],
      { websocket: false }
    );
    expect(filtered).toEqual([]);
  });
});

describe('sanitizePreviewResponseHeaders', () => {
  it('drops hop-by-hop, content-length and clear-site-data', () => {
    const sanitized = sanitizePreviewResponseHeaders(
      [
        { name: 'Connection', value: 'close' },
        { name: 'Keep-Alive', value: 'timeout=5' },
        { name: 'Proxy-Authenticate', value: 'x' },
        { name: 'Proxy-Authorization', value: 'x' },
        { name: 'Te', value: 'trailers' },
        { name: 'Trailer', value: 'x' },
        { name: 'Transfer-Encoding', value: 'chunked' },
        { name: 'Upgrade', value: 'h2c' },
        { name: 'Content-Length', value: '5' },
        { name: 'Clear-Site-Data', value: '"cache"' },
        { name: 'Content-Type', value: 'text/html' },
      ],
      { secure: true }
    );
    expect(sanitized).toEqual([{ name: 'Content-Type', value: 'text/html' }]);
  });

  it('drops both preview Set-Cookie names but keeps other cookies', () => {
    const sanitized = sanitizePreviewResponseHeaders(
      [
        { name: 'set-cookie', value: `${PREVIEW_COOKIE_NAME}=stolen; Path=/` },
        { name: 'set-cookie', value: `${PREVIEW_HOST_COOKIE_NAME}=stolen; Path=/` },
        { name: 'set-cookie', value: 'app=1; Path=/' },
      ],
      { secure: true }
    );
    expect(sanitized).toEqual([{ name: 'set-cookie', value: 'app=1; Path=/' }]);
  });

  it('strips Domain and Secure from every Set-Cookie by trimmed attribute name', () => {
    const sanitized = sanitizePreviewResponseHeaders(
      [
        { name: 'Set-Cookie', value: 'a=1; Domain=example.com; Secure; Path=/' },
        { name: 'Set-Cookie', value: 'b=2; Domain =x; SECURE; Path=/' },
        { name: 'Set-Cookie', value: 'domain=kept; Path=/' },
        { name: 'Set-Cookie', value: 'secure=kept; Path=/' },
        { name: 'Set-Cookie', value: 'd=4; Domain; Path=/' },
      ],
      { secure: false }
    );
    expect(sanitized).toEqual([
      { name: 'Set-Cookie', value: 'a=1; Path=/' },
      { name: 'Set-Cookie', value: 'b=2; Path=/' },
      { name: 'Set-Cookie', value: 'domain=kept; Path=/' },
      { name: 'Set-Cookie', value: 'secure=kept; Path=/' },
      { name: 'Set-Cookie', value: 'd=4; Path=/' },
    ]);
  });

  it('keeps Secure when the browser connection is secure', () => {
    const sanitized = sanitizePreviewResponseHeaders(
      [{ name: 'Set-Cookie', value: 'a=1; Domain=example.com; Secure; Path=/' }],
      { secure: true }
    );
    expect(sanitized).toEqual([{ name: 'Set-Cookie', value: 'a=1; Secure; Path=/' }]);
  });
});

describe('rewritePreviewLocation', () => {
  const origin = 'https://p5173-11111111111141118111111111111111.example.test';

  it('rewrites a same-port loopback Location to an absolute preview-origin URL', () => {
    expect(rewritePreviewLocation('http://localhost:5173/login?a=1', 5173, origin)).toBe(
      `${origin}/login?a=1`
    );
    expect(rewritePreviewLocation('http://127.0.0.1:5173/', 5173, origin)).toBe(`${origin}/`);
  });

  it.each(['0.0.0.0', '[::]', '[::1]'])(
    'rewrites a same-port %s Location as the sandbox, like the chat link parser',
    host => {
      expect(rewritePreviewLocation(`http://${host}:5173/login`, 5173, origin)).toBe(
        `${origin}/login`
      );
    }
  );

  it('leaves a Location with a different port or host unchanged', () => {
    expect(rewritePreviewLocation('http://localhost:9999/x', 5173, origin)).toBe(
      'http://localhost:9999/x'
    );
    expect(rewritePreviewLocation('https://example.com/x', 5173, origin)).toBe(
      'https://example.com/x'
    );
    expect(rewritePreviewLocation('/relative', 5173, origin)).toBe('/relative');
  });
});
