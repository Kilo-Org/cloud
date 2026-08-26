jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));
jest.mock('dns', () => ({
  lookup: jest.fn(),
}));

import { lookup as lookupCallback } from 'dns';
import { lookup } from 'dns/promises';
import { MediaProxyError, assertSafeMediaUrl, fetchSafeMedia, guardedLookup } from './media-proxy';

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  addresses: Array<{ address: string; family: number }>
) => void;

const mockLookup = lookup as jest.Mock;
const mockLookupCallback = lookupCallback as unknown as jest.Mock;
const mockFetch = jest.fn();

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 };

/** A valid PNG header plus padding, long enough for the magic-byte check. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

function upstreamResponse(
  body: BodyInit | null,
  status: number,
  headers: Record<string, string> | Headers
): Response {
  return new Response(body, { status, headers });
}

function pngResponse(): Response {
  return upstreamResponse(PNG_BYTES, 200, { 'content-type': 'image/png' });
}

describe('media-proxy', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([PUBLIC_ADDRESS]);
    mockLookupCallback.mockReset();
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
      ['198.18.0.1'],
      ['192.0.0.1'],
      ['240.0.0.1'],
      ['::1'],
      ['fe80::1'],
      ['fc00::1'],
      ['fd00::1'],
      ['fec0::1'],
      ['100::1'],
      ['::'],
      ['ff02::1'],
      ['2001:db8::1'],
      ['::ffff:7f00:1'],
    ])('rejects a host that resolves to %s', async address => {
      mockLookup.mockResolvedValue([{ address }]);
      await expect(assertSafeMediaUrl('https://example.com/a.png')).rejects.toThrow(
        'non-public address'
      );
    });

    it('rejects an answer set that mixes a public and a private address', async () => {
      mockLookup.mockResolvedValue([PUBLIC_ADDRESS, { address: '10.1.2.3', family: 4 }]);
      await expect(assertSafeMediaUrl('https://example.com/a.png')).rejects.toThrow(
        'non-public address'
      );
    });

    it('rejects an empty answer set', async () => {
      mockLookup.mockResolvedValue([]);
      await expect(assertSafeMediaUrl('https://example.com/a.png')).rejects.toThrow(
        'could not be resolved'
      );
    });

    it('rejects when the resolver rejects', async () => {
      mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(assertSafeMediaUrl('https://example.com/a.png')).rejects.toThrow(
        'could not be resolved'
      );
    });

    it('resolves a hostname with a trailing dot through DNS', async () => {
      mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(assertSafeMediaUrl('https://localhost./a.png')).rejects.toThrow(
        'non-public address'
      );
      expect(mockLookup).toHaveBeenCalledWith('localhost.', { all: true, verbatim: true });
    });

    it('rejects a literal loopback IP without resolving DNS', async () => {
      await expect(assertSafeMediaUrl('https://127.0.0.1/a.png')).rejects.toThrow(
        'non-public address'
      );
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('rejects an IPv4-mapped loopback literal without resolving DNS', async () => {
      await expect(assertSafeMediaUrl('https://[::ffff:127.0.0.1]/a.png')).rejects.toThrow(
        /invalid address|non-public address/
      );
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('rejects a URL whose host carries an IPv6 zone id', async () => {
      await expect(assertSafeMediaUrl('https://[fe80::1%25eth0]/a.png')).rejects.toThrow(
        'Invalid media URL'
      );
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('rejects a resolved address carrying a zone id', async () => {
      mockLookup.mockResolvedValue([{ address: 'fe80::1%eth0', family: 6 }]);
      await expect(assertSafeMediaUrl('https://example.com/a.png')).rejects.toThrow('zone id');
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

  describe('guardedLookup', () => {
    it('passes through when every resolved address is public', done => {
      mockLookupCallback.mockImplementation(
        (_hostname: string, _options: unknown, callback: LookupCallback) => {
          callback(null, [PUBLIC_ADDRESS]);
        }
      );
      guardedLookup('example.com', {}, (error, address, family) => {
        expect(error).toBeNull();
        expect(address).toBe('93.184.216.34');
        expect(family).toBe(4);
        done();
      });
    });

    it('returns the whole answer set when the caller asks for all addresses', done => {
      mockLookupCallback.mockImplementation(
        (_hostname: string, _options: unknown, callback: LookupCallback) => {
          callback(null, [PUBLIC_ADDRESS]);
        }
      );
      guardedLookup('example.com', { all: true }, (error, address) => {
        expect(error).toBeNull();
        expect(address).toEqual([PUBLIC_ADDRESS]);
        done();
      });
    });

    it('fails the connection when the connect-time answer is private', done => {
      mockLookupCallback.mockImplementation(
        (_hostname: string, _options: unknown, callback: LookupCallback) => {
          callback(null, [{ address: '169.254.169.254', family: 4 }]);
        }
      );
      guardedLookup('rebind.example.com', {}, error => {
        expect(error?.message).toContain('non-public address');
        done();
      });
    });

    it('fails the connection when one address of several is private', done => {
      mockLookupCallback.mockImplementation(
        (_hostname: string, _options: unknown, callback: LookupCallback) => {
          callback(null, [PUBLIC_ADDRESS, { address: '10.0.0.5', family: 4 }]);
        }
      );
      guardedLookup('rebind.example.com', { all: true }, error => {
        expect(error?.message).toContain('non-public address');
        done();
      });
    });

    it('forwards a resolver error', done => {
      mockLookupCallback.mockImplementation(
        (_hostname: string, _options: unknown, callback: LookupCallback) => {
          callback(new Error('ENOTFOUND'), []);
        }
      );
      guardedLookup('missing.example.com', {}, error => {
        expect(error?.message).toBe('ENOTFOUND');
        done();
      });
    });

    it('fails the connection when the answer set is empty', done => {
      mockLookupCallback.mockImplementation(
        (_hostname: string, _options: unknown, callback: LookupCallback) => {
          callback(null, []);
        }
      );
      guardedLookup('missing.example.com', {}, error => {
        expect(error?.message).toContain('could not be resolved');
        done();
      });
    });
  });

  describe('fetchSafeMedia', () => {
    it('returns a sanitized image response on success', async () => {
      mockFetch.mockResolvedValue(pngResponse());

      const response = await fetchSafeMedia('https://example.com/a.png');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
    });

    it('fetches with manual redirect handling and the guarded dispatcher', async () => {
      mockFetch.mockResolvedValue(pngResponse());

      await fetchSafeMedia('https://example.com/a.png');

      const init = mockFetch.mock.calls[0]?.[1];
      expect(init?.redirect).toBe('manual');
      expect(init?.dispatcher).toBeDefined();
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

    it.each([
      ['http://example.com/b.png', 'must use https'],
      ['data:image/png;base64,AAAA', 'must use https'],
      ['file:///etc/passwd', 'must use https'],
      ['https://user:pass@example.com/b.png', 'must not include credentials'],
    ])('rejects a redirect to %s', async (location, message) => {
      mockFetch.mockResolvedValueOnce(upstreamResponse(null, 302, { location }));

      await expect(fetchSafeMedia('https://example.com/a.png')).rejects.toThrow(message);
    });

    it('resolves a relative Location against the current hop', async () => {
      mockFetch
        .mockResolvedValueOnce(upstreamResponse(null, 302, { location: '/b.png' }))
        .mockResolvedValueOnce(pngResponse());

      await fetchSafeMedia('https://example.com/dir/a.png');

      expect(String(mockFetch.mock.calls[1]?.[0])).toBe('https://example.com/b.png');
    });

    it('follows exactly three redirects and then succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(upstreamResponse(null, 301, { location: 'https://example.com/b' }))
        .mockResolvedValueOnce(upstreamResponse(null, 302, { location: 'https://example.com/c' }))
        .mockResolvedValueOnce(upstreamResponse(null, 308, { location: 'https://example.com/d' }))
        .mockResolvedValueOnce(pngResponse());

      const response = await fetchSafeMedia('https://example.com/a.png');

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(4);
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

    it('rejects a redirect without a Location header', async () => {
      mockFetch.mockResolvedValueOnce(upstreamResponse(null, 302, {}));

      await expect(fetchSafeMedia('https://example.com/a.png')).rejects.toThrow(
        'missing a Location header'
      );
    });

    it.each([[300], [304], [305]])(
      'treats %i as an upstream error rather than a redirect',
      async status => {
        mockFetch.mockResolvedValueOnce(upstreamResponse(null, status, {}));

        await expect(fetchSafeMedia('https://example.com/a.png')).rejects.toThrow(
          `Upstream returned ${status}.`
        );
      }
    );

    it('reports a non-ok upstream status', async () => {
      mockFetch.mockResolvedValueOnce(upstreamResponse(null, 403, {}));

      await expect(fetchSafeMedia('https://example.com/a.png')).rejects.toThrow(
        'Upstream returned 403.'
      );
    });

    it('forwards only the content type, cache control, and nosniff headers', async () => {
      const upstreamHeaders = new Headers();
      upstreamHeaders.set('content-type', 'image/jpeg');
      upstreamHeaders.append('set-cookie', 'session=abc');
      upstreamHeaders.set('www-authenticate', 'Basic realm="proxy"');
      upstreamHeaders.set('x-powered-by', 'origin');
      mockFetch.mockResolvedValue(upstreamResponse(JPEG_BYTES, 200, upstreamHeaders));

      const response = await fetchSafeMedia('https://example.com/a.jpg');

      expect([...response.headers.keys()].sort()).toEqual([
        'cache-control',
        'content-type',
        'x-content-type-options',
      ]);
      expect(response.headers.get('cache-control')).toBe('private, max-age=300');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('rejects a non-image content type', async () => {
      mockFetch.mockResolvedValue(
        upstreamResponse(PNG_BYTES, 200, { 'content-type': 'text/html' })
      );

      await expect(fetchSafeMedia('https://example.com/a')).rejects.toThrow(
        'not an allowed image type'
      );
    });

    it('rejects a missing content type', async () => {
      mockFetch.mockResolvedValue(upstreamResponse(PNG_BYTES, 200, {}));

      await expect(fetchSafeMedia('https://example.com/a')).rejects.toThrow(
        'not an allowed image type'
      );
    });

    it('rejects bytes that do not match the declared image type', async () => {
      mockFetch.mockResolvedValue(
        upstreamResponse(new Uint8Array([0x3c, 0x21, 0x64, 0x6f, 0x63, 0, 0, 0, 0, 0, 0, 0]), 200, {
          'content-type': 'image/png',
        })
      );

      await expect(fetchSafeMedia('https://example.com/a.png')).rejects.toThrow(
        'does not match its declared image type'
      );
    });

    it('rejects an empty upstream body', async () => {
      mockFetch.mockResolvedValue(
        upstreamResponse(new Uint8Array(), 200, { 'content-type': 'image/png' })
      );

      await expect(fetchSafeMedia('https://example.com/a.png')).rejects.toThrow(
        'Media body is empty.'
      );
    });

    it('passes an abort signal to every upstream fetch', async () => {
      mockFetch.mockResolvedValue(pngResponse());

      await fetchSafeMedia('https://example.com/a.png');

      expect(mockFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it('rejects a body that exceeds the cap without buffering all of it', async () => {
      const chunk = new Uint8Array(1024 * 1024);
      chunk.set(PNG_BYTES, 0);
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      mockFetch.mockResolvedValue(
        upstreamResponse(body, 200, { 'content-type': 'image/png', 'content-length': '10' })
      );

      const response = await fetchSafeMedia('https://example.com/endless.png');
      await expect(response.arrayBuffer()).rejects.toThrow('exceeds the size limit');
      expect(pulls).toBeLessThanOrEqual(16);
      expect(cancelled).toBe(true);
    });

    it('rejects a Content-Length above the cap even when the body is small', async () => {
      mockFetch.mockResolvedValue(
        upstreamResponse(PNG_BYTES, 200, {
          'content-type': 'image/png',
          'content-length': String(10 * 1024 * 1024 + 1),
        })
      );

      await expect(fetchSafeMedia('https://example.com/big.png')).rejects.toThrow(
        'exceeds the size limit'
      );
    });

    it('rejects a single body chunk larger than 10 MiB', async () => {
      const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
      oversized.set(PNG_BYTES, 0);
      mockFetch.mockResolvedValue(
        upstreamResponse(oversized, 200, { 'content-type': 'image/png' })
      );

      await expect(fetchSafeMedia('https://example.com/big.png')).rejects.toThrow(
        'exceeds the size limit'
      );
    });

    it('errors the stream once the streamed body passes 10 MiB', async () => {
      const chunk = new Uint8Array(1024 * 1024);
      chunk.set(PNG_BYTES, 0);
      let remaining = 11;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (remaining === 0) {
            controller.close();
            return;
          }
          remaining -= 1;
          controller.enqueue(chunk);
        },
      });
      mockFetch.mockResolvedValue(upstreamResponse(body, 200, { 'content-type': 'image/png' }));

      const response = await fetchSafeMedia('https://example.com/big.png');
      await expect(response.arrayBuffer()).rejects.toThrow('exceeds the size limit');
    });

    it('surfaces the guard error a blocked connect lookup rejects with', async () => {
      const guardError = new TypeError('fetch failed');
      (guardError as { cause?: unknown }).cause = new MediaProxyError(
        'Media URL host resolves to a non-public address.'
      );
      mockFetch.mockRejectedValue(guardError);

      await expect(fetchSafeMedia('https://example.com/a.png')).rejects.toThrow(
        'non-public address'
      );
    });
  });
});
