jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));

import { lookup } from 'dns/promises';
import { assertSafeMediaUrl, fetchSafeMedia } from './media-proxy';

const mockLookup = lookup as jest.Mock;
const mockFetch = jest.fn();

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 };

function upstreamResponse(
  body: BodyInit | null,
  status: number,
  headers: Record<string, string> | Headers
): Response {
  return new Response(body, { status, headers });
}

describe('media-proxy', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([PUBLIC_ADDRESS]);
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('assertSafeMediaUrl', () => {
    it('accepts a hostname that resolves only to public addresses', async () => {
      await expect(assertSafeMediaUrl('https://example.com/a.png')).resolves.toBeInstanceOf(URL);
      expect(mockLookup).toHaveBeenCalledWith('example.com', { all: true, verbatim: true });
    });

    it('does not resolve a literal public IP', async () => {
      await expect(assertSafeMediaUrl('https://93.184.216.34/a.png')).resolves.toBeInstanceOf(URL);
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it.each([
      ['127.0.0.1'],
      ['10.0.0.1'],
      ['172.16.0.1'],
      ['192.168.1.1'],
      ['169.254.169.254'],
      ['0.0.0.0'],
      ['224.0.0.1'],
      ['::1'],
      ['fe80::1'],
      ['fc00::1'],
      ['fd00::1'],
      ['::'],
      ['ff02::1'],
      ['2001:db8::1'],
    ])('rejects a host that resolves to %s', async address => {
      mockLookup.mockResolvedValue([{ address }]);
      await expect(assertSafeMediaUrl('https://example.com/a.png')).rejects.toThrow(
        'non-public address'
      );
    });

    it('rejects a literal loopback IP without resolving DNS', async () => {
      await expect(assertSafeMediaUrl('https://127.0.0.1/a.png')).rejects.toThrow(
        'non-public address'
      );
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('rejects localhost and .local hosts without resolving DNS', async () => {
      await expect(assertSafeMediaUrl('https://localhost/a.png')).rejects.toThrow(
        'not publicly reachable'
      );
      await expect(assertSafeMediaUrl('https://printer.local/a.png')).rejects.toThrow(
        'not publicly reachable'
      );
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it.each([
      ['ftp://example.com/a.png', 'must use https'],
      ['http://example.com/a.png', 'must use https'],
      ['https://user:pass@example.com/a.png', 'must not include credentials'],
    ])('rejects unsafe scheme or credentials in %s', async (input, message) => {
      await expect(assertSafeMediaUrl(input)).rejects.toThrow(message);
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('rejects an unparsable URL', async () => {
      await expect(assertSafeMediaUrl('not a url')).rejects.toThrow('Invalid media URL');
      expect(mockLookup).not.toHaveBeenCalled();
    });
  });

  describe('fetchSafeMedia', () => {
    it('returns a sanitized image response on success', async () => {
      mockFetch.mockResolvedValue(
        upstreamResponse(new Uint8Array([1, 2, 3, 4]), 200, { 'content-type': 'image/png' })
      );

      const response = await fetchSafeMedia('https://example.com/a.png');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it('rejects a redirect hop to a private destination', async () => {
      mockLookup.mockImplementation(async (hostname: string) => {
        if (hostname === 'evil.example.com') {
          return [{ address: '192.168.1.10', family: 4 }];
        }
        return [PUBLIC_ADDRESS];
      });
      mockFetch.mockResolvedValue(
        upstreamResponse(null, 302, { location: 'https://evil.example.com/a.png' })
      );

      await expect(fetchSafeMedia('https://example.com/a.png')).rejects.toThrow(
        'non-public address'
      );
    });

    it('rejects more than three redirect hops', async () => {
      mockFetch.mockResolvedValue(
        upstreamResponse(null, 302, { location: 'https://example.com/b.png' })
      );

      await expect(fetchSafeMedia('https://example.com/a.png')).rejects.toThrow(
        'Too many redirects.'
      );
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('strips Set-Cookie, Set-Cookie2, and WWW-Authenticate from the response', async () => {
      const upstreamHeaders = new Headers();
      upstreamHeaders.set('content-type', 'image/jpeg');
      upstreamHeaders.append('set-cookie', 'session=abc');
      upstreamHeaders.append('set-cookie2', 'legacy=1');
      upstreamHeaders.set('www-authenticate', 'Basic realm="proxy"');
      mockFetch.mockResolvedValue(upstreamResponse(new Uint8Array([9]), 200, upstreamHeaders));

      const response = await fetchSafeMedia('https://example.com/a.jpg');

      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('set-cookie2')).toBeNull();
      expect(response.headers.get('www-authenticate')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('private');
    });

    it('rejects a non-image content type', async () => {
      mockFetch.mockResolvedValue(
        upstreamResponse(new Uint8Array([1]), 200, { 'content-type': 'text/html' })
      );

      await expect(fetchSafeMedia('https://example.com/a')).rejects.toThrow(
        'not an allowed image type'
      );
    });

    it('rejects a body larger than 10 MiB', async () => {
      mockFetch.mockResolvedValue(
        upstreamResponse(new Uint8Array(10 * 1024 * 1024 + 1), 200, {
          'content-type': 'image/png',
        })
      );

      await expect(fetchSafeMedia('https://example.com/big.png')).rejects.toThrow(
        'exceeds the size limit'
      );
    });

    it('stops reading at the size cap without buffering the full body', async () => {
      const totalBytes = 20 * 1024 * 1024;
      let produced = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced >= totalBytes) {
            controller.close();
            return;
          }
          const size = Math.min(1024 * 1024, totalBytes - produced);
          const chunk = new Uint8Array(size);
          produced += size;
          controller.enqueue(chunk);
        },
      });

      mockFetch.mockResolvedValue(
        new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } })
      );

      await expect(fetchSafeMedia('https://example.com/big.png')).rejects.toThrow(
        'exceeds the size limit'
      );

      // The upstream stream offers 20 MiB; the proxy must abort long before the
      // producer can emit it all. If the proxy buffered the whole body (the old
      // arrayBuffer path), `produced` would reach `totalBytes`.
      expect(produced).toBeLessThan(totalBytes);
    });
  });
});
