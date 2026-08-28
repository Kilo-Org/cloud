jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('https', () => ({ request: jest.fn() }));

import { lookup } from 'dns/promises';
import { EventEmitter } from 'events';
import * as https from 'https';
import { PassThrough } from 'stream';
import { fetchGitLab } from './safe-transport';

const mockFetch = jest.fn();
const mockLookup = lookup as jest.Mock;
const mockRequest = https.request as jest.Mock;
const instanceUrl = 'https://gitlab.com/gitlab';
const url = `${instanceUrl}/api/v4/projects/123`;
const policy = { instanceUrl, maxRequestBytes: 256_000, rejectRedirects: false };

beforeEach(() => {
  global.fetch = mockFetch;
  mockFetch.mockReset();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  mockRequest.mockReset();
});

it.each([
  'https://evil.example/gitlab/api/v4/projects/123',
  'https://gitlab.com:8443/gitlab/api/v4/projects/123',
  'https://gitlab.com/gitlab-other/api/v4/projects/123',
  'https://gitlab.com/api/v4/projects/123',
  'https://user:secret@gitlab.com/gitlab/api/v4/projects/123',
  'https://gitlab.com/gitlab/api/v4/projects/a%2F..%2F..%2Fother',
])('rejects an unauthorized destination before network access: %s', async destination => {
  await expect(fetchGitLab(destination, undefined, policy)).rejects.toMatchObject({
    code: 'unsafe_url',
  });
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

it('rejects an oversized UTF-8 request before DNS or provider access', async () => {
  await expect(
    fetchGitLab(url, { method: 'POST', body: 'é'.repeat(128_001) }, policy)
  ).rejects.toMatchObject({ code: 'request_too_large' });
  expect(mockLookup).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it('accepts a request at the byte ceiling without truncation', async () => {
  let receivedBytes = 0;
  mockFetch.mockImplementationOnce(async (_url, init) => {
    receivedBytes = Buffer.byteLength(init.body);
    return new Response(null, { status: 204 });
  });
  const response = await fetchGitLab(url, { method: 'POST', body: 'é'.repeat(128_000) }, policy);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  expect(receivedBytes).toBe(256_000);
});

it('revalidates read redirects and retains the configured subpath', async () => {
  const paths: string[] = [];
  mockFetch.mockImplementation(async (destination, init) => {
    expect(init.redirect).toBe('manual');
    paths.push(destination);
    return paths.length === 1
      ? new Response(null, { status: 302, headers: { location: `${url}?page=2` } })
      : Response.json({ id: 123 });
  });
  expect(await (await fetchGitLab(url, undefined, policy)).json()).toEqual({ id: 123 });
  expect(paths).toEqual([url, `${url}?page=2`]);
});

it.each([
  'https://evil.example/gitlab/api/v4/projects/123',
  'https://gitlab.com/api/v4/projects/123',
])('blocks redirect escape to %s', async location => {
  mockFetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
  await expect(fetchGitLab(url, undefined, policy)).rejects.toMatchObject({ code: 'unsafe_url' });
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it.each([301, 302, 303, 307, 308])(
  'never replays an interactive write on redirect %s',
  async status => {
    let writes = 0;
    mockFetch.mockImplementation(async () => {
      writes++;
      return new Response(null, { status, headers: { location: url } });
    });
    await expect(
      fetchGitLab(url, { method: 'POST', body: '{}' }, { ...policy, rejectRedirects: true })
    ).rejects.toMatchObject({ code: 'redirect' });
    expect(writes).toBe(1);
  }
);

it('terminates a redirect loop at the existing five-hop bound', async () => {
  mockFetch.mockImplementation(
    async () => new Response(null, { status: 302, headers: { location: url } })
  );
  await expect(fetchGitLab(url, undefined, policy)).rejects.toThrow(
    'GitLab request exceeded redirect limit'
  );
  expect(mockFetch).toHaveBeenCalledTimes(6);
});

it.each(['10485761', 'invalid'])(
  'rejects an excessive or invalid content length: %s',
  async length => {
    mockFetch.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': length } }));
    await expect(fetchGitLab(url, undefined, policy)).rejects.toMatchObject({
      code: 'response_too_large',
    });
  }
);

it('cancels an oversized streamed response even with a false content length', async () => {
  let cancelled = false;
  mockFetch.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-length': '1' } }
    )
  );
  await expect(fetchGitLab(url, undefined, policy)).rejects.toMatchObject({
    code: 'response_too_large',
  });
  expect(cancelled).toBe(true);
});

it('binds a self-managed request to the vetted DNS address and TLS host', async () => {
  let boundAddress: string | undefined;
  let boundHost: string | undefined;
  let requestedPath: string | undefined;
  mockRequest.mockImplementationOnce((options: any, callback: any) => {
    options.lookup(options.hostname, {}, (_error: unknown, address: string) => {
      boundAddress = address;
    });
    boundHost = options.servername;
    requestedPath = options.path;
    const request = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      destroy: jest.fn(),
      setTimeout: jest.fn(),
      end() {
        const response = Object.assign(new PassThrough(), {
          statusCode: 200,
          statusMessage: 'OK',
          headers: { 'content-type': 'application/json' },
        });
        callback(response);
        response.end('{"id":123}');
      },
    });
    return request as never;
  });
  const host = 'https://gitlab.example.com/gitlab';
  const response = await fetchGitLab(
    `${host}/api/v4/projects/group%2Fsubgroup%2Fproject`,
    undefined,
    { ...policy, instanceUrl: host }
  );
  expect(await response.json()).toEqual({ id: 123 });
  expect({ boundAddress, boundHost, requestedPath }).toEqual({
    boundAddress: '93.184.216.34',
    boundHost: 'gitlab.example.com',
    requestedPath: '/gitlab/api/v4/projects/group%2Fsubgroup%2Fproject',
  });
  expect(mockFetch).not.toHaveBeenCalled();
});

it('rejects a hostname when any DNS answer is private', async () => {
  mockLookup.mockResolvedValueOnce([
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ] as never);
  const host = 'https://gitlab.example.com/gitlab';
  await expect(
    fetchGitLab(`${host}/api/v4/projects/123`, undefined, { ...policy, instanceUrl: host })
  ).rejects.toThrow('resolves to an address that is not allowed');
  expect(mockRequest).not.toHaveBeenCalled();
});

it('applies the 30-second timeout to native fetch', async () => {
  const timeouts: number[] = [];
  const controller = new AbortController();
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    timeouts.push(milliseconds);
    return controller.signal;
  });
  mockFetch.mockImplementationOnce(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        controller.abort(new DOMException('timed out', 'TimeoutError'));
      })
  );
  try {
    await expect(fetchGitLab(url, undefined, policy)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(timeouts).toEqual([30_000]);
  } finally {
    timeout.mockRestore();
  }
});
