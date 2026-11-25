const mockNextAuthHttpHandler = jest.fn<Promise<Response>, [NextRequest, unknown]>();

jest.mock('@/lib/user/next-auth-options', () => ({
  nextAuthHttpHandler: (...args: [NextRequest, unknown]) => mockNextAuthHttpHandler(...args),
}));

import { NextRequest } from 'next/server';
import { claimWebSignInDevice } from '@/lib/auth/web-sign-in-device';
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

describe('browser device cookie', () => {
  const context = { params: Promise.resolve({ nextauth: ['callback', 'google'] }) };
  const existingSecret = 'A'.repeat(43);

  function signInRequest(cookie?: string) {
    return new NextRequest('https://app.kilo.ai/api/auth/callback/google?code=c&state=s', {
      headers: cookie ? { cookie } : {},
    });
  }

  /** A NextAuth handler that completes a sign-in, as the `jwt` callback does. */
  function completeSignIn(headers: HeadersInit = {}) {
    let claimed: ReturnType<typeof claimWebSignInDevice> = null;
    mockNextAuthHttpHandler.mockImplementation(async () => {
      claimed = claimWebSignInDevice();
      const response = new Headers(headers);
      response.set('Location', 'https://app.kilo.ai/users/after-sign-in');
      return new Response(null, { status: 302, headers: response });
    });
    return () => claimed;
  }

  test('a sign-in sets the cookie whose value the detection recorded', async () => {
    const claimed = completeSignIn();

    const response = await GET(signInRequest(), context);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://app.kilo.ai/users/after-sign-in');
    const setCookie = response.headers.get('set-cookie') ?? '';
    const value = /__Host-kilo-device=([^;]+)/.exec(setCookie)?.[1];
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(claimed()?.device).toEqual({ kind: 'browser_cookie', secret: value });
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=None/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=34560000/);
  });

  test('a sign-in keeps the browser cookie it already holds', async () => {
    const claimed = completeSignIn();

    const response = await GET(signInRequest(`__Host-kilo-device=${existingSecret}`), context);

    expect(claimed()?.device).toEqual({ kind: 'browser_cookie', secret: existingSecret });
    expect(response.headers.get('set-cookie')).toContain(`__Host-kilo-device=${existingSecret}`);
  });

  test("Apple's cross-site form POST callback keeps the browser cookie", async () => {
    const claimed = completeSignIn();
    const request = new NextRequest('https://app.kilo.ai/api/auth/callback/apple', {
      method: 'POST',
      headers: {
        cookie: `__Host-kilo-device=${existingSecret}`,
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://appleid.apple.com',
      },
      body: new URLSearchParams({ code: 'c', state: 's' }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ nextauth: ['callback', 'apple'] }),
    });

    expect(claimed()?.device).toEqual({ kind: 'browser_cookie', secret: existingSecret });
    const deviceCookies = response.headers
      .getSetCookie()
      .filter(cookie => cookie.startsWith('__Host-kilo-device='));
    expect(deviceCookies).toHaveLength(1);
    expect(/^__Host-kilo-device=([^;]+)/.exec(deviceCookies[0] ?? '')?.[1]).toBe(existingSecret);
  });

  test("NextAuth's own Set-Cookie headers pass through byte for byte", async () => {
    const sessionToken =
      '__Secure-next-auth.session-token=fake-session-token.part-2; Path=/; Expires=Fri, 25 Dec 2026 12:00:00 GMT; HttpOnly; Secure; SameSite=Lax';
    const clearedState =
      '__Secure-next-auth.state=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned';
    const headers = new Headers({ 'x-nextauth': 'kept' });
    headers.append('set-cookie', sessionToken);
    headers.append('set-cookie', clearedState);
    completeSignIn(headers);

    const response = await GET(signInRequest(), context);

    expect(response.status).toBe(302);
    expect(response.headers.get('x-nextauth')).toBe('kept');
    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toHaveLength(3);
    expect(setCookies[0]).toBe(sessionToken);
    expect(setCookies[1]).toBe(clearedState);
    expect(setCookies[2]).toMatch(/^__Host-kilo-device=[A-Za-z0-9_-]{43}; /);
  });

  test('a malformed cookie is replaced', async () => {
    const claimed = completeSignIn();

    await GET(signInRequest('__Host-kilo-device=short'), context);

    const device = claimed()?.device;
    expect(device?.kind === 'browser_cookie' && device.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('a request that signs nobody in leaves the cookie alone', async () => {
    const nextAuthResponse = new Response(null, { status: 200 });
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);

    const response = await GET(signInRequest(), context);

    expect(response).toBe(nextAuthResponse);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
