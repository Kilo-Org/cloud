import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { checkUpstreamUrl, upstreamDispatcher } from '@kilocode/upstream-url-policy';
import { handleSecureProxyRequest } from './secure-proxy';

vi.mock('@kilocode/upstream-url-policy', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkUpstreamUrl: vi.fn(),
}));

const policyCheck = vi.mocked(checkUpstreamUrl);

const originalFetch = global.fetch;
const originalSecret = process.env.KILO_AI_GATEWAY_SECURE_PROXY_SECRET;
const PROXY_SECRET = 'proxy-secret';
const VALID_UPSTREAM_BODY = {
  kilo_secure_proxy: { url: 'https://llm.example.com', headers: {} },
};

function proxyRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://secure-proxy.example.com/api/proxy', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${PROXY_SECRET}`,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function mockUpstream(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  global.fetch = fetchMock;
  return fetchMock;
}

function onlyFetchCall(fetchMock: Mock<typeof fetch>) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  return { url, init, headers: new Headers(init?.headers) };
}

describe('handleSecureProxyRequest', () => {
  beforeEach(() => {
    process.env.KILO_AI_GATEWAY_SECURE_PROXY_SECRET = PROXY_SECRET;
    vi.stubEnv('VERCEL_TARGET_ENV', 'development');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.KILO_AI_GATEWAY_SECURE_PROXY_SECRET = originalSecret;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ['a missing authorization header', { authorization: '' }],
    ['a wrong secret', { authorization: 'Bearer wrong-secret' }],
    ['the secret without the Bearer scheme', { authorization: PROXY_SECRET }],
  ])('rejects %s without calling upstream', async (_description, headers) => {
    const fetchMock = mockUpstream(new Response('{}'));

    const response = await handleSecureProxyRequest(proxyRequest(VALID_UPSTREAM_BODY, headers));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects every request when the secret is not configured', async () => {
    delete process.env.KILO_AI_GATEWAY_SECURE_PROXY_SECRET;
    const fetchMock = mockUpstream(new Response('{}'));

    const response = await handleSecureProxyRequest(proxyRequest(VALID_UPSTREAM_BODY));

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the body without the config to the configured URL with the configured headers', async () => {
    const fetchMock = mockUpstream(new Response('{"ok":true}', { status: 200 }));

    await handleSecureProxyRequest(
      proxyRequest(
        {
          model: 'upstream-model',
          messages: [{ role: 'user', content: 'hello' }],
          kilo_secure_proxy: {
            url: 'https://llm.example.com/v1/chat/completions?api-version=1',
            headers: { authorization: 'Bearer upstream-key', 'x-custom': 'value' },
          },
        },
        { cookie: 'session=1', 'x-forwarded-for': '203.0.113.1' }
      )
    );

    const { url, init, headers } = onlyFetchCall(fetchMock);
    expect(url).toBe('https://llm.example.com/v1/chat/completions?api-version=1');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'upstream-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(Object.fromEntries(headers)).toEqual({
      authorization: 'Bearer upstream-key',
      'content-type': 'application/json',
      'x-custom': 'value',
    });
  });

  it('returns the upstream body and status with only safe response headers', async () => {
    mockUpstream(
      new Response('data: hello\n\n', {
        status: 429,
        headers: {
          'content-type': 'text/event-stream',
          'request-id': 'req-1',
          'set-cookie': 'upstream=1',
          'x-upstream-secret': 'leak',
        },
      })
    );

    const response = await handleSecureProxyRequest(
      proxyRequest({
        kilo_secure_proxy: { url: 'https://llm.example.com/v1/messages', headers: {} },
      })
    );

    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toBe('data: hello\n\n');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('request-id')).toBe('req-1');
    expect(response.headers.get('content-encoding')).toBe('identity');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-upstream-secret')).toBeNull();
  });

  it.each([
    ['a non-JSON body', 'not json'],
    ['a missing config', { model: 'm' }],
    ['a non-HTTPS URL', { kilo_secure_proxy: { url: 'http://llm.example.com', headers: {} } }],
    [
      'an invalid header name',
      { kilo_secure_proxy: { url: 'https://llm.example.com', headers: { 'bad header': 'x' } } },
    ],
  ])('rejects %s without calling upstream', async (_description, body) => {
    const fetchMock = mockUpstream(new Response('{}'));

    const response = await handleSecureProxyRequest(proxyRequest(body));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns an upstream redirect into an error without exposing the location', async () => {
    mockUpstream(
      new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.com' } })
    );

    const response = await handleSecureProxyRequest(proxyRequest(VALID_UPSTREAM_BODY));

    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error:
        'Upstream responded with a redirect (HTTP 307), which the secure proxy does not follow',
    });
  });

  it('returns 502 without details when the upstream fetch fails', async () => {
    global.fetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('connect ECONNREFUSED https://llm.example.com'));

    const response = await handleSecureProxyRequest(proxyRequest(VALID_UPSTREAM_BODY));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'Upstream request failed' });
  });

  it('logs fetch failures with the upstream host only', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    global.fetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('fetch failed', { cause }));

    await handleSecureProxyRequest(
      proxyRequest({
        kilo_secure_proxy: {
          url: 'https://llm.example.com/v1/chat/completions?key=query-secret',
          headers: { authorization: 'Bearer upstream-key' },
        },
      })
    );

    expect(console.error).toHaveBeenCalledWith('[secure-proxy] Upstream request failed', {
      upstreamHost: 'llm.example.com',
      errorName: 'TypeError',
      causeName: 'Error',
      causeCode: 'ECONNREFUSED',
    });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain('query-secret');
    expect(logged).not.toContain('upstream-key');
  });
});

function setTargetEnvironment(value: string | undefined): void {
  if (value === undefined) delete process.env.VERCEL_TARGET_ENV;
  else process.env.VERCEL_TARGET_ENV = value;
}

describe.each(['production', 'staging', 'preview'])('deployment selection: %s', targetEnv => {
  const originalTargetEnv = process.env.VERCEL_TARGET_ENV;

  beforeEach(() => {
    process.env.VERCEL_TARGET_ENV = targetEnv;
    process.env.KILO_AI_GATEWAY_SECURE_PROXY_SECRET = PROXY_SECRET;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    policyCheck.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setTargetEnvironment(originalTargetEnv);
    process.env.KILO_AI_GATEWAY_SECURE_PROXY_SECRET = originalSecret;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('refuses an upstream URL the policy rejects without contacting it', async () => {
    policyCheck.mockResolvedValue({ allowed: false, violation: 'non_public_host' });
    const fetchMock = mockUpstream(new Response('{}'));

    const response = await handleSecureProxyRequest(proxyRequest(VALID_UPSTREAM_BODY));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Upstream request refused: non_public_host',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(policyCheck).toHaveBeenCalledWith('https://llm.example.com', {
      signal: expect.anything() as AbortSignal,
    });
  });

  it('connects through the pinned dispatcher once the URL is approved', async () => {
    policyCheck.mockResolvedValue({
      allowed: true,
      hostname: 'llm.example.com',
      addresses: ['104.18.2.115'],
    });
    const fetchMock = mockUpstream(new Response('{}'));

    const response = await handleSecureProxyRequest(proxyRequest(VALID_UPSTREAM_BODY));

    expect(response.status).toBe(200);
    const { init } = onlyFetchCall(fetchMock);
    expect(init?.redirect).toBe('manual');
    expect((init as { dispatcher?: unknown } | undefined)?.dispatcher).toBe(upstreamDispatcher());
  });

  it.each(['development', undefined])('preserves the rollout: %s', async targetEnv => {
    setTargetEnvironment(targetEnv);
    vi.stubEnv('NODE_ENV', 'development');
    const fetchMock = mockUpstream(new Response('{"ok":true}'));

    const response = await handleSecureProxyRequest(proxyRequest(VALID_UPSTREAM_BODY));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(policyCheck).not.toHaveBeenCalled();
    const { init } = onlyFetchCall(fetchMock);
    expect((init as { dispatcher?: unknown } | undefined)?.dispatcher).toBeUndefined();
  });
});
