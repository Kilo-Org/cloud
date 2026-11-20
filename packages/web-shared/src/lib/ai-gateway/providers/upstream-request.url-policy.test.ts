import type { Dispatcher } from 'undici';
import { captureException } from '@sentry/nextjs';
import { buildDirectProvider } from './build-direct-provider';
import {
  UpstreamAddressUnverifiedError,
  clearUpstreamConnectionCache,
  lookupPinnedUpstreamAddress,
  upstreamDispatcherFor,
} from './upstream-connection';
import { UPSTREAM_DURATION_BUDGET_MS, upstreamRequest } from './upstream-request';
import { clearUpstreamUrlPolicyCache } from './upstream-url-policy';

const mockResolve4 = jest.fn<Promise<string[]>, [string]>();

// The policy resolves A and AAAA records through c-ares; the tests answer the A
// query and leave the AAAA query empty.
jest.mock('node:dns/promises', () => ({
  Resolver: jest.fn(function () {
    return {
      resolve4: (hostname: string) => mockResolve4(hostname),
      resolve6: async () => [],
      cancel: jest.fn(),
    };
  }),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));

const originalFetch = global.fetch;
const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
};

const PUBLIC_IP_URL = 'https://104.18.2.115/v1';

function directProvider(base_url: string) {
  return buildDirectProvider(
    'custom',
    ['chat_completions'],
    { base_url },
    { type: 'api_key', apiKey: 'upstream-key', apiKeyHeader: null }
  );
}

function secureProxyProvider(proxyUrl: string, upstreamUrl: string) {
  return buildDirectProvider(
    'custom',
    ['chat_completions'],
    { base_url: proxyUrl },
    {
      type: 'secure_proxy',
      credentials: {
        type: 'secure_proxy',
        proxy_secret: 'proxy-secret',
        config: { url: upstreamUrl },
      },
    }
  );
}

function mockFetch(response: Response = new Response('{}')) {
  const fetchMock = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  global.fetch = fetchMock;
  return fetchMock;
}

function send(provider: ReturnType<typeof directProvider>, signal?: AbortSignal) {
  return upstreamRequest({
    chatApi: 'chat_completions',
    search: '',
    method: 'POST',
    body: { model: 'upstream-model', messages: [{ role: 'user', content: 'hi' }] },
    extraHeaders: {},
    provider,
    signal,
    vercelRequestId: 'fra1::abc',
    reasoningEffort: null,
    durationBudgetMs: UPSTREAM_DURATION_BUDGET_MS,
  });
}

function pinnedAddressOf(hostname: string) {
  const calls: Array<[unknown, unknown, unknown]> = [];
  lookupPinnedUpstreamAddress(hostname, { all: false }, (error, address, family) => {
    calls.push([error, address, family]);
  });
  return calls;
}

function setEnv(name: keyof typeof originalEnv, value: string | undefined) {
  const env: Record<string, string | undefined> = process.env;
  if (value === undefined) delete env[name];
  else env[name] = value;
}

const FUTURE_EXPIRY = () => Date.now() + 60_000;

describe('upstreamRequest upstream URL policy', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
    clearUpstreamConnectionCache();
    mockResolve4.mockReset();
    jest.mocked(captureException).mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setEnv('NODE_ENV', originalEnv.NODE_ENV);
    setEnv('VERCEL_TARGET_ENV', originalEnv.VERCEL_TARGET_ENV);
  });

  describe.each([
    ['production', 'production'],
    ['production', 'staging'],
    ['production', 'preview'],
    ['production', undefined],
  ])('when NODE_ENV is %s and VERCEL_TARGET_ENV is %s', (nodeEnv, targetEnv) => {
    beforeEach(() => {
      setEnv('NODE_ENV', nodeEnv);
      setEnv('VERCEL_TARGET_ENV', targetEnv);
    });

    it('sends to a public HTTPS upstream without following redirects', async () => {
      const fetchMock = mockFetch();

      const result = await send(directProvider(PUBLIC_IP_URL));

      expect(result.type).toBe('success');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${PUBLIC_IP_URL}/chat/completions`);
      expect(init?.redirect).toBe('manual');
    });

    it('pins the checked address the request dials', async () => {
      mockResolve4.mockResolvedValue(['104.18.2.115']);
      const fetchMock = mockFetch();

      await send(directProvider('https://llm.example.com/v1'));

      expect(pinnedAddressOf('llm.example.com')).toEqual([[null, '104.18.2.115', 4]]);
      const [, init] = fetchMock.mock.calls[0];
      const dispatcher = (init as (RequestInit & { dispatcher?: Dispatcher }) | undefined)
        ?.dispatcher;
      // undici exposes the connect options of an Agent only behind private
      // symbols, so the pool's identity is the public proof that this request
      // dials the checked host with the address pinned above.
      expect(dispatcher).toBe(
        upstreamDispatcherFor('llm.example.com', ['104.18.2.115'], FUTURE_EXPIRY())
      );
    });

    it('reports a refused connection apart from an upstream failure', async () => {
      mockResolve4.mockResolvedValue(['104.18.2.115']);
      // A refused pin reaches the request as a fetch error whose cause is the
      // refusal, which `upstream-connection.test.ts` shows on this runtime.
      const refusal = new UpstreamAddressUnverifiedError(
        'llm.example.com',
        'the refreshed check could not verify the host'
      );
      mockFetch().mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), { cause: refusal })
      );

      const result = await send(directProvider('https://llm.example.com/v1'));

      if (result.type !== 'error') throw new Error('expected an error result');
      expect(result.response.status).toBe(503);
      expect((await result.response.json()).error_type).toBe('upstream_disconnect');
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(
        refusal,
        expect.objectContaining({
          tags: expect.objectContaining({ source: 'ai-gateway-upstream-connection' }),
        })
      );
    });

    it('pins the proxy host for a secure proxy request', async () => {
      mockResolve4.mockImplementation(async hostname => [
        hostname.startsWith('proxy.') ? '104.18.2.115' : '104.18.3.116',
      ]);
      const fetchMock = mockFetch();

      await send(
        secureProxyProvider('https://proxy.example.com/api', 'https://llm.example.com/v1')
      );

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://proxy.example.com/api');
      const dispatcher = (init as (RequestInit & { dispatcher?: Dispatcher }) | undefined)
        ?.dispatcher;
      // The request dials the proxy; the relayed upstream URL travels in the
      // body.
      expect(dispatcher).toBe(
        upstreamDispatcherFor('proxy.example.com', ['104.18.2.115'], FUTURE_EXPIRY())
      );
      expect(dispatcher).not.toBe(
        upstreamDispatcherFor('llm.example.com', ['104.18.3.116'], FUTURE_EXPIRY())
      );
    });

    it('keeps the first checked address when a second resolution would answer another', async () => {
      mockResolve4.mockResolvedValueOnce(['104.18.2.115']).mockResolvedValue(['10.1.2.3']);
      mockFetch();

      await send(directProvider('https://llm.example.com/v1'));
      await send(directProvider('https://llm.example.com/v1'));

      expect(mockResolve4).toHaveBeenCalledTimes(1);
      expect(pinnedAddressOf('llm.example.com')).toEqual([[null, '104.18.2.115', 4]]);
    });

    it('re-checks the host when the request dials after the pin expired', async () => {
      mockResolve4.mockResolvedValueOnce(['104.18.2.115']).mockResolvedValue(['104.18.9.9']);
      const fetchMock = mockFetch();

      await send(directProvider('https://llm.example.com/v1'));
      expect(mockResolve4).toHaveBeenCalledTimes(1);

      // The pin outlives a connection but not the request budget, so a request
      // that dials after the TTL asks the URL policy for a fresh check and
      // dials what that check approved.
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
      await send(directProvider('https://llm.example.com/v1'));

      expect(mockResolve4).toHaveBeenCalledTimes(2);
      expect(pinnedAddressOf('llm.example.com')).toEqual([[null, '104.18.9.9', 4]]);
      const [, init] = fetchMock.mock.calls[1];
      expect((init as (RequestInit & { dispatcher?: Dispatcher }) | undefined)?.dispatcher).toBe(
        upstreamDispatcherFor('llm.example.com', ['104.18.9.9'], FUTURE_EXPIRY())
      );
      jest.restoreAllMocks();
    });

    it('reports the second request when a re-check fails after both caches expired', async () => {
      mockResolve4
        .mockResolvedValueOnce(['104.18.2.115'])
        .mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
      const fetchMock = mockFetch();

      await send(directProvider('https://llm.example.com/v1'));
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
      const result = await send(directProvider('https://llm.example.com/v1'));

      // Past both cache windows the request-start check runs again and its
      // failure answers the caller: the fetch never ran and the answer stays
      // the generic upstream failure. The connect-time refusal, where the
      // check succeeds but the connection is not verified, is covered in
      // `upstream-connection.test.ts` (stale-pin refresh and refusals) and by
      // the refused-connection reporting test above.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (result.type !== 'error') throw new Error('expected an error result');
      expect(result.response.status).toBe(503);
      expect((await result.response.json()).error_type).toBe('temporarily_unavailable');
      jest.restoreAllMocks();
    });

    it.each([
      ['http://104.18.2.115/v1', 'does not use HTTPS'],
      ['https://localhost:8080/v1', 'its host is not public'],
      ['https://169.254.169.254/latest', 'its host is not public'],
      ['https://[::1]/v1', 'its host is not public'],
    ])('rejects %s before sending anything', async (baseUrl, reason) => {
      const fetchMock = mockFetch();

      const result = await send(directProvider(baseUrl));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.type).toBe('error');
      expect(result.response.status).toBe(502);
      const body = await result.response.json();
      expect(body).toMatchObject({
        error_type: 'upstream_error',
        vercel_request_id: 'fra1::abc',
      });
      expect(body.error).toContain(reason);
      expect(body.error).not.toContain(baseUrl);
    });

    it('reports an unresolvable host as temporarily unavailable', async () => {
      mockResolve4.mockRejectedValue(new Error('getaddrinfo ENOTFOUND llm.example.com'));
      const fetchMock = mockFetch();

      const result = await send(directProvider('https://llm.example.com/v1'));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.response.status).toBe(503);
      const body = await result.response.json();
      expect(body.error_type).toBe('temporarily_unavailable');
      expect(body.error).toContain('could not resolve the upstream provider host');
    });

    it.each([
      ['an AbortError', () => new DOMException('client went away', 'AbortError')],
      // Next.js aborts the request signal with this error when the client goes away.
      ['a ResponseAborted error', () => Object.assign(new Error(), { name: 'ResponseAborted' })],
    ])(
      'releases the request when the client disconnects with %s during a stalled DNS lookup',
      async (_label, reason) => {
        mockResolve4.mockReturnValue(new Promise(() => {}));
        const fetchMock = mockFetch();
        const client = new AbortController();

        const pending = send(directProvider('https://llm.example.com/v1'), client.signal);
        client.abort(reason());
        const result = await pending;

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.type).toBe('error');
        expect(result.response.status).toBe(499);
        expect((await result.response.json()).error_type).toBe('client_disconnect');
      }
    );

    it('rejects a secure proxy request whose upstream URL is not public', async () => {
      const fetchMock = mockFetch();

      const result = await send(secureProxyProvider(PUBLIC_IP_URL, 'https://10.0.0.5/v1'));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.response.status).toBe(502);
    });

    it('rejects a secure proxy URL that is not public', async () => {
      const fetchMock = mockFetch();

      const result = await send(secureProxyProvider('https://127.0.0.1/api/proxy', PUBLIC_IP_URL));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.response.status).toBe(502);
    });

    it('turns an upstream redirect into an error instead of passing it through', async () => {
      mockFetch(new Response(null, { status: 307, headers: { location: 'https://10.0.0.5/' } }));

      const result = await send(directProvider(PUBLIC_IP_URL));

      expect(result.type).toBe('error');
      expect(result.response.status).toBe(502);
      const body = await result.response.json();
      expect(body.error).toContain('responded with a redirect');
    });
  });

  it.each(['development', 'test'])(
    'leaves the request unchecked when NODE_ENV is %s',
    async nodeEnv => {
      setEnv('NODE_ENV', nodeEnv);
      setEnv('VERCEL_TARGET_ENV', 'production');
      const fetchMock = mockFetch();

      const result = await send(directProvider('http://localhost:8080/v1'));

      expect(result.type).toBe('success');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:8080/v1/chat/completions');
      expect(init?.redirect).toBe('follow');
      expect((init as { dispatcher?: unknown } | undefined)?.dispatcher).toBeUndefined();
    }
  );
});
