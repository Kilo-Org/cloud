import { SecureProxyRequestBodySchema } from '@kilocode/ai-gateway-secure-proxy-contracts';
import { STS_SECURE_PROXY_FORWARD } from '@kilocode/sts-contracts';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { generateProviderSpecificHash } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { stsServiceTokenIfHeld } from '@kilocode/web-shared/lib/sts-service-tokens';
import { buildDirectProvider } from './build-direct-provider';
import { UPSTREAM_DURATION_BUDGET_MS, upstreamRequest } from './upstream-request';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  // Read at each send, so a test sets the switch through `mockSenderAuth`.
  get SECURE_PROXY_SENDER_AUTH() {
    return mockSenderAuth.value;
  },
}));

jest.mock('@kilocode/web-shared/lib/sts-service-tokens', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/sts-service-tokens'),
  stsServiceTokenIfHeld: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));

const mockSenderAuth: { value: string | undefined } = { value: undefined };
const heldToken = jest.mocked(stsServiceTokenIfHeld);
const PRODUCTION = {
  VERCEL_ENV: 'production',
  VERCEL_TARGET_ENV: 'production',
  KILO_STS_WORKLOAD: 'ai-gateway',
} as const;

const originalFetch = global.fetch;

function secureProxyProvider(disable_url_suffix: boolean, user_hash_as_mt_user_id: boolean) {
  return buildDirectProvider(
    'custom',
    ['chat_completions'],
    {
      internal_id: 'upstream-model',
      base_url: 'https://secure-proxy.example.com/api/proxy',
      disable_url_suffix,
      user_hash_as_mt_user_id,
      extra_headers: { 'x-definition-header': 'definition' },
    },
    {
      type: 'secure_proxy',
      credentials: {
        type: 'secure_proxy',
        proxy_secret: 'proxy-secret',
        config: {
          url: 'https://llm.example.com/v1',
          extra_headers: { Authorization: 'Bearer upstream-key' },
        },
      },
    }
  );
}

async function sendUpstream(
  disable_url_suffix: boolean,
  user_hash_as_mt_user_id = false,
  prompt_cache_key = 'task-cache-key'
) {
  const fetchMock = jest.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}')
  );
  global.fetch = fetchMock;
  const body = {
    model: 'upstream-model',
    messages: [{ role: 'user' as const, content: 'hi' }],
    prompt_cache_key,
  };
  const provider = secureProxyProvider(disable_url_suffix, user_hash_as_mt_user_id);
  const extraHeaders: Record<string, string> = {};
  await provider.transformRequest({
    provider,
    model: 'public-model',
    request: { kind: 'chat_completions', body },
    originalHeaders: EmptyFraudDetectionHeaders,
    extraHeaders,
    userByok: null,
    kilo_user_id: 'user-1',
    organization_id: null,
    session_id: null,
  });

  const result = await upstreamRequest({
    chatApi: 'chat_completions',
    search: '?trace=1',
    method: 'POST',
    body,
    extraHeaders,
    provider,
    reasoningEffort: null,
    durationBudgetMs: UPSTREAM_DURATION_BUDGET_MS,
  });
  return { result, fetchMock, sent: body };
}

async function sendThroughSecureProxy(
  disable_url_suffix: boolean,
  user_hash_as_mt_user_id = false,
  prompt_cache_key = 'task-cache-key'
) {
  const { result, fetchMock, sent } = await sendUpstream(
    disable_url_suffix,
    user_hash_as_mt_user_id,
    prompt_cache_key
  );
  expect(result.type).toBe('success');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  return {
    url,
    init,
    headers: new Headers(init?.headers),
    body: SecureProxyRequestBodySchema.parse(JSON.parse(init?.body as string)),
    sent,
  };
}

describe('upstreamRequest through the secure proxy', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    mockSenderAuth.value = undefined;
    heldToken.mockReset();
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_TARGET_ENV;
    delete process.env.KILO_STS_WORKLOAD;
  });

  it('sends only the proxy secret to the proxy and moves upstream auth into the body', async () => {
    const { url, init, headers, body, sent } = await sendThroughSecureProxy(false);

    expect(url).toBe('https://secure-proxy.example.com/api/proxy');
    expect(init?.redirect).toBe('follow');
    expect(Object.fromEntries(headers)).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer proxy-secret',
    });
    expect(heldToken).not.toHaveBeenCalled();
    expect(body).toEqual({
      ...sent,
      kilo_secure_proxy: {
        url: 'https://llm.example.com/v1/chat/completions?trace=1',
        headers: {
          authorization: 'Bearer upstream-key',
          'content-type': 'application/json',
          'http-referer': 'https://kilocode.ai',
          'x-definition-header': 'definition',
          'x-title': 'Kilo Code',
        },
      },
    });
    expect(sent).not.toHaveProperty('kilo_secure_proxy');
  });

  it('applies disable_url_suffix to the upstream URL and never changes the proxy URL', async () => {
    const { url, body } = await sendThroughSecureProxy(true);

    expect(url).toBe('https://secure-proxy.example.com/api/proxy');
    expect(body.kilo_secure_proxy.url).toBe('https://llm.example.com/v1?trace=1');
  });

  it('sends the prefixed Mt-User-Id only to the upstream when enabled', async () => {
    const { headers, body } = await sendThroughSecureProxy(false, true);

    expect(headers.has('Mt-User-Id')).toBe(false);
    expect(body.kilo_secure_proxy.headers['mt-user-id']).toBe(
      'kilo:' + generateProviderSpecificHash('user-1', secureProxyProvider(false, true))
    );
  });

  it.each(['\u4e2d\u6587', 'key\r\nInjected: value', 'key\0'])(
    'sends the user hash when cache key %s cannot be used as a header',
    async cacheKey => {
      const { body } = await sendThroughSecureProxy(false, true, cacheKey);

      expect(body.kilo_secure_proxy.headers['mt-user-id']).toBe(
        'kilo:' + generateProviderSpecificHash('user-1', secureProxyProvider(false, true))
      );
      expect(body.prompt_cache_key).toBe(cacheKey);
    }
  );
});

describe('the secure proxy forward under SECURE_PROXY_SENDER_AUTH', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    mockSenderAuth.value = undefined;
    heldToken.mockReset();
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_TARGET_ENV;
    delete process.env.KILO_STS_WORKLOAD;
    jest.restoreAllMocks();
  });

  it('sends only a held STS token to the exact proxy, never the stored secret', async () => {
    mockSenderAuth.value = 'sts';
    Object.assign(process.env, PRODUCTION);
    heldToken.mockResolvedValue({ kind: 'token', token: 'sts-token' });

    const { url, init, headers, body, sent } = await sendThroughSecureProxy(false);

    expect(url).toBe('https://secure-proxy.example.com/api/proxy');
    expect(init?.redirect).toBe('error');
    expect(Object.fromEntries(headers)).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sts-token',
    });
    expect(JSON.stringify(init)).not.toContain('proxy-secret');
    expect(body.kilo_secure_proxy.url).toBe('https://llm.example.com/v1/chat/completions?trace=1');
    expect(sent).not.toHaveProperty('kilo_secure_proxy');
    expect(heldToken).toHaveBeenCalledWith('production', STS_SECURE_PROXY_FORWARD);
  });

  it('refuses the forward as retryable while no token is held, with no blocking mint', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSenderAuth.value = 'sts';
    Object.assign(process.env, PRODUCTION);
    heldToken.mockResolvedValue({ kind: 'not_held' });

    const { result, fetchMock } = await sendUpstream(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(503);
    expect(result.notInvoked).toBe(true);
    expect(await result.response.json()).toMatchObject({
      error_type: 'temporarily_unavailable',
    });
    // The sender asks for a held token only; the read that mints one runs on in the background.
    expect(heldToken).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a value outside the closed set', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSenderAuth.value = 'dual';

    const { result, fetchMock } = await sendUpstream(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(503);
    expect(result.notInvoked).toBe(true);
    expect(heldToken).not.toHaveBeenCalled();
  });

  it('sends nothing from a build that is not the ai-gateway workload', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSenderAuth.value = 'sts';
    delete process.env.KILO_STS_WORKLOAD;
    Object.assign(process.env, { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' });

    const { result, fetchMock } = await sendUpstream(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.response.status).toBe(503);
    expect(heldToken).not.toHaveBeenCalled();
  });
});
