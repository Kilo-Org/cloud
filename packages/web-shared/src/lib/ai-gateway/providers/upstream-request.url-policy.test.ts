import { lookup } from 'node:dns/promises';
import { buildDirectProvider } from './build-direct-provider';
import { upstreamRequest } from './upstream-request';
import { clearUpstreamUrlPolicyCache } from './upstream-url-policy';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));

const originalFetch = global.fetch;
const originalTargetEnv = process.env.VERCEL_TARGET_ENV;

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
  });
}

const lookupMock = jest.mocked(lookup);

function setTargetEnv(value: string | undefined) {
  if (value === undefined) delete process.env.VERCEL_TARGET_ENV;
  else process.env.VERCEL_TARGET_ENV = value;
}

describe('upstreamRequest upstream URL policy', () => {
  beforeEach(() => {
    clearUpstreamUrlPolicyCache();
    lookupMock.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setTargetEnv(originalTargetEnv);
  });

  describe.each(['production', 'staging'])('when VERCEL_TARGET_ENV is %s', targetEnv => {
    beforeEach(() => {
      setTargetEnv(targetEnv);
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
      lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND llm.example.com'));
      const fetchMock = mockFetch();

      const result = await send(directProvider('https://llm.example.com/v1'));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.response.status).toBe(503);
      const body = await result.response.json();
      expect(body.error_type).toBe('temporarily_unavailable');
      expect(body.error).toContain('could not resolve the upstream provider host');
    });

    it('releases the request when the client disconnects during a stalled DNS lookup', async () => {
      lookupMock.mockReturnValue(new Promise(() => {}));
      const fetchMock = mockFetch();
      const client = new AbortController();

      const pending = send(directProvider('https://llm.example.com/v1'), client.signal);
      client.abort(new DOMException('client went away', 'AbortError'));
      const result = await pending;

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.type).toBe('error');
      expect(result.response.status).toBe(499);
      expect((await result.response.json()).error_type).toBe('client_disconnect');
    });

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

  it.each(['preview', 'development', undefined])(
    'leaves the request unchecked when VERCEL_TARGET_ENV is %s',
    async targetEnv => {
      setTargetEnv(targetEnv);
      const fetchMock = mockFetch();

      const result = await send(directProvider('http://localhost:8080/v1'));

      expect(result.type).toBe('success');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:8080/v1/chat/completions');
      expect(init?.redirect).toBe('follow');
    }
  );
});
