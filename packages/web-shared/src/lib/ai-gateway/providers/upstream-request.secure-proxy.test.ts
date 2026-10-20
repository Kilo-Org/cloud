import { SecureProxyRequestBodySchema } from '@kilocode/ai-gateway-secure-proxy-contracts';
import { buildDirectProvider } from './build-direct-provider';
import { upstreamRequest } from './upstream-request';

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

function secureProxyProvider(disable_url_suffix: boolean) {
  return buildDirectProvider(
    'custom',
    ['chat_completions'],
    {
      base_url: 'https://secure-proxy.example.com/api/proxy',
      disable_url_suffix,
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

async function sendThroughSecureProxy(disable_url_suffix: boolean) {
  const fetchMock = jest.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}')
  );
  global.fetch = fetchMock;
  const body = { model: 'upstream-model', messages: [{ role: 'user' as const, content: 'hi' }] };

  const result = await upstreamRequest({
    chatApi: 'chat_completions',
    search: '?trace=1',
    method: 'POST',
    body,
    extraHeaders: { 'x-definition-header': 'definition' },
    provider: secureProxyProvider(disable_url_suffix),
    reasoningEffort: null,
  });

  expect(result.type).toBe('success');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  return {
    url,
    headers: new Headers(init?.headers),
    body: SecureProxyRequestBodySchema.parse(JSON.parse(String(init?.body))),
    sent: body,
  };
}

describe('upstreamRequest through the secure proxy', () => {
  beforeEach(() => {
    process.env.VERCEL_TARGET_ENV = 'development';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalTargetEnv === undefined) delete process.env.VERCEL_TARGET_ENV;
    else process.env.VERCEL_TARGET_ENV = originalTargetEnv;
  });

  it('sends only the proxy secret to the proxy and moves upstream auth into the body', async () => {
    const { url, headers, body, sent } = await sendThroughSecureProxy(false);

    expect(url).toBe('https://secure-proxy.example.com/api/proxy');
    expect(Object.fromEntries(headers)).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer proxy-secret',
    });
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
});
