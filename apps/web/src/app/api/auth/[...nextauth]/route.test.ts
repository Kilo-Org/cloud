const mockNextAuthHttpHandler = jest.fn<Promise<Response>, [NextRequest, unknown]>();

jest.mock('@/lib/user/next-auth-options', () => ({
  nextAuthHttpHandler: (...args: [NextRequest, unknown]) => mockNextAuthHttpHandler(...args),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from './route';

beforeEach(() => {
  jest.clearAllMocks();
  mockNextAuthHttpHandler.mockResolvedValue(new Response(null, { status: 200 }));
});

describe('GET /api/auth/[...nextauth]', () => {
  test.each<[string, string[]]>([
    ['callback/email', ['callback', 'email']],
    ['callback/passkey', ['callback', 'passkey']],
    ['callback/email/', ['callback', 'email']],
    ['callback/passkey/', ['callback', 'passkey']],
    ['%63allback/%65mail', ['callback', 'email']],
    ['%63allback/%70asskey', ['callback', 'passkey']],
    ['callback/email/extra', ['callback', 'email', 'extra']],
    ['callback/passkey/extra', ['callback', 'passkey', 'extra']],
  ])('rejects unsupported credentials callback %s', async (path, nextauth) => {
    mockNextAuthHttpHandler.mockResolvedValue(
      new Response('Callback for provider type credentials not supported', { status: 500 })
    );
    const request = new NextRequest(
      `https://app.kilo.ai/api/auth/${path}?code=invalid-code&state=invalid-state`
    );
    const context = { params: Promise.resolve({ nextauth }) };

    const response = await GET(request, context);

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(mockNextAuthHttpHandler).not.toHaveBeenCalled();
  });

  test.each<[string, string[]]>([
    ['callback/google', ['callback', 'google']],
    ['callback/github', ['callback', 'github']],
    ['callback/unknown', ['callback', 'unknown']],
    ['callback/email-other', ['callback', 'email-other']],
    ['callback/passkey-other', ['callback', 'passkey-other']],
    ['signin/email', ['signin', 'email']],
    ['signin/passkey', ['signin', 'passkey']],
    ['session', ['session']],
  ])('delegates allowed GET route %s to NextAuth', async (path, nextauth) => {
    const request = new NextRequest(`https://app.kilo.ai/api/auth/${path}`);
    const context = { params: Promise.resolve({ nextauth }) };
    const nextAuthResponse = new Response(null, { status: 302 });
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);

    const response = await GET(request, context);

    expect(response).toBe(nextAuthResponse);
    expect(mockNextAuthHttpHandler).toHaveBeenCalledTimes(1);
    expect(mockNextAuthHttpHandler).toHaveBeenCalledWith(request, context);
  });

  test('preserves genuine OAuth callback errors', async () => {
    const request = new NextRequest('https://app.kilo.ai/api/auth/callback/google');
    const context = { params: Promise.resolve({ nextauth: ['callback', 'google'] }) };
    const nextAuthResponse = new Response('OAuth callback failed', { status: 500 });
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);

    const response = await GET(request, context);

    expect(response).toBe(nextAuthResponse);
    expect(response.status).toBe(500);
    expect(response.headers.has('Allow')).toBe(false);
  });

  test('preserves GitHub issuer normalization and OAuth state', async () => {
    const request = new NextRequest(
      'https://app.kilo.ai/api/auth/callback/github?code=oauth-code&state=oauth-state&iss=https://github.com/login/oauth'
    );
    const context = { params: Promise.resolve({ nextauth: ['callback', 'github'] }) };

    await GET(request, context);

    expect(mockNextAuthHttpHandler).toHaveBeenCalledTimes(1);
    const [forwardedRequest, forwardedContext] = mockNextAuthHttpHandler.mock.calls[0];
    expect(forwardedRequest.nextUrl.pathname).toBe('/api/auth/callback/github');
    expect(forwardedRequest.nextUrl.searchParams.has('iss')).toBe(false);
    expect(forwardedRequest.nextUrl.searchParams.get('code')).toBe('oauth-code');
    expect(forwardedRequest.nextUrl.searchParams.get('state')).toBe('oauth-state');
    expect(forwardedContext).toBe(context);
    expect(request.nextUrl.searchParams.has('iss')).toBe(true);
  });
});

describe('POST /api/auth/[...nextauth]', () => {
  test.each(['email', 'passkey'])('delegates credentials callback %s unchanged', async provider => {
    const request = new NextRequest(`https://app.kilo.ai/api/auth/callback/${provider}`, {
      method: 'POST',
      body: new URLSearchParams({
        csrfToken: 'test-csrf',
        token: 'test-token',
        ticket: 'test-ticket',
      }),
    });
    const context = { params: Promise.resolve({ nextauth: ['callback', provider] }) };
    const nextAuthResponse = new Response(null, { status: 302 });
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);

    const response = await POST(request, context);

    expect(response).toBe(nextAuthResponse);
    expect(mockNextAuthHttpHandler).toHaveBeenCalledTimes(1);
    expect(mockNextAuthHttpHandler).toHaveBeenCalledWith(request, context);
    expect(await request.text()).toBe('csrfToken=test-csrf&token=test-token&ticket=test-ticket');
  });
});
