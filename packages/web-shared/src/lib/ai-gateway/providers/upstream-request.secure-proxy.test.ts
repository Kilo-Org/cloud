import { SecureProxyRequestBodySchema } from '@kilocode/ai-gateway-secure-proxy-contracts';
import { ServiceTokenError } from '@kilocode/service-token-client';
import { STS_SECURE_PROXY_FORWARD } from '@kilocode/sts-contracts';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { generateProviderSpecificHash } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { stsServiceToken } from '@kilocode/web-shared/lib/sts-service-tokens';
import { buildDirectProvider } from './build-direct-provider';
import { SECURE_PROXY_COLD_TOKEN_WAIT_MS } from './secure-proxy-sts';
import { UPSTREAM_DURATION_BUDGET_MS, upstreamRequest } from './upstream-request';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  // Read at each send, so a test sets both through `mockConfig`.
  get SECURE_PROXY_SENDER_AUTH() {
    return mockConfig.auth;
  },
  get SECURE_PROXY_EXPECTED_ORIGIN() {
    return mockConfig.expectedOrigin;
  },
}));

jest.mock('@kilocode/web-shared/lib/sts-service-tokens', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/sts-service-tokens'),
  stsServiceToken: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));

const mockConfig: { auth: string | undefined; expectedOrigin: string | undefined } = {
  auth: undefined,
  expectedOrigin: undefined,
};
const mintedToken = jest.mocked(stsServiceToken);
const PROXY_ORIGIN = 'https://secure-proxy.example.com';
const PRODUCTION = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' } as const;

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
    mockConfig.auth = undefined;
    mintedToken.mockReset();
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
    expect(mintedToken).not.toHaveBeenCalled();
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
    mockConfig.auth = undefined;
    mockConfig.expectedOrigin = undefined;
    mintedToken.mockReset();
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_TARGET_ENV;
    delete process.env.KILO_STS_WORKLOAD;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function useSts(auth: string = 'sts') {
    mockConfig.auth = auth;
    mockConfig.expectedOrigin = PROXY_ORIGIN;
    Object.assign(process.env, PRODUCTION);
    process.env.KILO_STS_WORKLOAD = 'ai-gateway';
  }

  it('sends only a held STS token to the exact proxy, never the stored secret', async () => {
    useSts();
    mintedToken.mockResolvedValue('sts-token');

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
    expect(mintedToken).toHaveBeenCalledWith('production', STS_SECURE_PROXY_FORWARD);
  });

  it('sends the request with the token when a cold instance’s mint answers in 100 ms', async () => {
    useSts();
    mintedToken.mockImplementation(() => {
      const { promise, resolve } = Promise.withResolvers<string>();
      setTimeout(() => resolve('sts-token'), 100);
      return promise;
    });
    jest.useFakeTimers();

    const pending = sendUpstream(false);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(100);
    const { result, fetchMock } = await pending;

    expect(result.type).toBe('success');
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sts-token');
  });

  it('refuses a cold instance’s forward at exactly 2000 ms when the mint never answers, with no fetch', async () => {
    useSts();
    const never = Promise.withResolvers<string>();
    mintedToken.mockReturnValue(never.promise);
    jest.useFakeTimers();

    const pending = sendUpstream(false);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(SECURE_PROXY_COLD_TOKEN_WAIT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    const { result, fetchMock } = await pending;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.notInvoked).toBe(true);
    expect(result.response.status).toBe(503);
    const body = (await result.response.json()) as { error?: string; error_type?: string };
    expect(body.error_type).toBe('temporarily_unavailable');
    expect(body.error).toMatch(/retry/i);
  });

  const refusals: Array<{
    name: string;
    setup: () => void;
    status: number;
    code: string;
    retryable: boolean;
  }> = [
    {
      name: 'an unknown switch value',
      setup: () => {
        mockConfig.auth = 'dual';
      },
      status: 500,
      code: 'secure_proxy_credential_misconfigured',
      retryable: false,
    },
    {
      name: 'a build that is not the ai-gateway workload',
      setup: () => {
        useSts();
        delete process.env.KILO_STS_WORKLOAD;
      },
      status: 500,
      code: 'secure_proxy_credential_misconfigured',
      retryable: false,
    },
    {
      name: 'an unset expected proxy origin',
      setup: () => {
        useSts();
        mockConfig.expectedOrigin = undefined;
      },
      status: 500,
      code: 'secure_proxy_credential_misconfigured',
      retryable: false,
    },
    {
      name: 'a proxy origin other than the expected one',
      setup: () => {
        useSts();
        mockConfig.expectedOrigin = 'https://other-proxy.example.com';
      },
      status: 500,
      code: 'secure_proxy_credential_misconfigured',
      retryable: false,
    },
    {
      name: 'a deployment without an STS environment',
      setup: () => {
        useSts();
        process.env.VERCEL_TARGET_ENV = 'staging';
      },
      status: 500,
      code: 'secure_proxy_credential_misconfigured',
      retryable: false,
    },
    {
      name: 'a token STS denied',
      setup: () => {
        useSts();
        mintedToken.mockImplementation(() =>
          Promise.reject(
            new ServiceTokenError(
              { reason: 'denied', deniedReason: 'scope_not_allowed' },
              STS_SECURE_PROXY_FORWARD
            )
          )
        );
      },
      status: 500,
      code: 'secure_proxy_credential_misconfigured',
      retryable: false,
    },
    {
      name: 'a token STS could not mint in time',
      setup: () => {
        useSts();
        mintedToken.mockImplementation(() =>
          Promise.reject(
            new ServiceTokenError(
              { reason: 'unavailable', retryAfterSeconds: 30 },
              STS_SECURE_PROXY_FORWARD
            )
          )
        );
      },
      status: 503,
      code: 'temporarily_unavailable',
      retryable: true,
    },
  ];

  it.each(refusals)(
    'answers $name with $status and $code',
    async ({ setup, status, code, retryable }) => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      setup();

      const { result, fetchMock } = await sendUpstream(false);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.type).toBe('error');
      if (result.type !== 'error') throw new Error('expected an error result');
      expect(result.notInvoked).toBe(true);
      expect(result.response.status).toBe(status);
      const body = (await result.response.json()) as { error?: string; error_type?: string };
      expect(body.error_type).toBe(code);
      if (retryable) expect(body.error).toMatch(/retry/i);
      else expect(body.error).not.toMatch(/retry/i);
    }
  );

  it('never mints for an origin mismatch or a misconfigured switch', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    useSts();
    mockConfig.expectedOrigin = undefined;
    await sendUpstream(false);
    mockConfig.expectedOrigin = PROXY_ORIGIN;
    mockConfig.auth = 'dual';
    await sendUpstream(false);
    expect(mintedToken).not.toHaveBeenCalled();
  });
});
