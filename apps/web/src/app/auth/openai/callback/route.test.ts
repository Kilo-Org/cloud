const mockNextAuthHttpHandler = jest.fn<Promise<Response>, [NextRequest, unknown]>();
const mockGetUserFromSession = jest.fn<Promise<{ id: string } | null>, []>();
const mockGetAccountLinkingSession = jest.fn<Promise<{ organizationId?: string } | null>, []>();

jest.mock('@/lib/user/server', () => ({
  nextAuthHttpHandler: (...args: [NextRequest, unknown]) => mockNextAuthHttpHandler(...args),
  getUserFromSession: () => mockGetUserFromSession(),
}));

jest.mock('@/lib/account-linking-session', () => ({
  getAccountLinkingSession: () => mockGetAccountLinkingSession(),
}));

import { NextRequest } from 'next/server';
import { GET } from './route';

const CALLBACK_URL = 'https://app.kilo.ai/auth/openai/callback';
const ORG_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  mockNextAuthHttpHandler.mockResolvedValue(new Response(null, { status: 200 }));
  mockGetAccountLinkingSession.mockResolvedValue(null);
});

function forwardedRequest(): NextRequest | undefined {
  return mockNextAuthHttpHandler.mock.calls[0]?.[0];
}

function forwardedContext(): { params: Promise<{ nextauth: string[] }> } | undefined {
  return mockNextAuthHttpHandler.mock.calls[0]?.[1] as
    | { params: Promise<{ nextauth: string[] }> }
    | undefined;
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe('GET /auth/openai/callback', () => {
  test('rewrites the registered callback path to the next-auth openai callback', async () => {
    mockGetUserFromSession.mockResolvedValue(null);
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    await GET(request, {});

    expect(mockNextAuthHttpHandler).toHaveBeenCalledTimes(1);
    expect(forwardedRequest()?.nextUrl.pathname).toBe('/api/auth/callback/openai');
    expect(forwardedRequest()?.nextUrl.searchParams.get('code')).toBe('the-code');
    expect(forwardedRequest()?.nextUrl.searchParams.get('state')).toBe('the-state');
    // NextAuth's App Router adapter picks the action and provider from
    // `context.params.nextauth`; without them the delegated call takes its
    // legacy API-handler path, which cannot read a NextRequest at all.
    await expect(forwardedContext()?.params).resolves.toEqual({ nextauth: ['callback', 'openai'] });
  });

  test('redirects a callback error to BYOK when a session exists', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    const request = new NextRequest(`${CALLBACK_URL}?error=access_denied&state=the-state`);

    const response = await GET(request, {});

    expect(mockNextAuthHttpHandler).not.toHaveBeenCalled();
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/byok');
    expect(location.searchParams.get('openai_error')).toBe('access_denied');
  });

  test('redirects a callback error to the organization BYOK page when the linking session carries one', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    mockGetAccountLinkingSession.mockResolvedValue({ organizationId: ORG_ID });
    const request = new NextRequest(`${CALLBACK_URL}?error=access_denied&state=the-state`);

    const response = await GET(request, {});

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe(`/organizations/${ORG_ID}/byok`);
    expect(location.searchParams.get('openai_error')).toBe('access_denied');
  });

  test('falls through to next-auth on a callback error without a session', async () => {
    mockGetUserFromSession.mockResolvedValue(null);
    const request = new NextRequest(`${CALLBACK_URL}?error=access_denied&state=the-state`);

    await GET(request, {});

    expect(mockNextAuthHttpHandler).toHaveBeenCalledTimes(1);
    expect(forwardedRequest()?.nextUrl.pathname).toBe('/api/auth/callback/openai');
    expect(forwardedRequest()?.nextUrl.searchParams.get('error')).toBe('access_denied');
  });

  test('redirects an internal callback failure to BYOK when a session exists', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    mockNextAuthHttpHandler.mockResolvedValue(
      redirectResponse('https://app.kilo.ai/api/auth/error?error=OAuthCallback')
    );
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    expect(mockNextAuthHttpHandler).toHaveBeenCalledTimes(1);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/byok');
    expect(location.searchParams.get('openai_error')).toBe('OAuthCallback');
  });

  test('redirects the bare sign-in hop next-auth emits when the callback has no usable profile', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    // `routes/callback.js` returns `${url}/signin` with no error parameter when
    // the exchange yields no profile/account: the only sign-in hop the callback
    // action itself emits. The error hop above is followed by the browser, not
    // by this route, so this shape is what reaches us from the token exchange.
    mockNextAuthHttpHandler.mockResolvedValue(
      redirectResponse('http://localhost:3000/api/auth/signin')
    );
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/byok');
    expect(location.searchParams.get('openai_error')).toBe('OAuthCallback');
  });

  test('keeps the error code a sign-in hop carries', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    mockNextAuthHttpHandler.mockResolvedValue(
      redirectResponse('https://app.kilo.ai/api/auth/signin?error=OAuthAccountNotLinked')
    );
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/byok');
    expect(location.searchParams.get('openai_error')).toBe('OAuthAccountNotLinked');
  });

  test('redirects the app sign-in hop that carries a failure code to BYOK', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    // An expired linking session makes the callback's own `signIn` callback
    // refuse the link and redirect to the app's sign-in route; without this the
    // person lands on the sign-in page with no card message.
    mockNextAuthHttpHandler.mockResolvedValue(
      redirectResponse('https://app.kilo.ai/users/sign_in?error=TURNSTILE_REQUIRED')
    );
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/byok');
    expect(location.searchParams.get('openai_error')).toBe('TURNSTILE_REQUIRED');
  });

  test('redirects the app sign-in hop to the organization BYOK page when the linking session carries one', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    mockGetAccountLinkingSession.mockResolvedValue({ organizationId: ORG_ID });
    mockNextAuthHttpHandler.mockResolvedValue(
      redirectResponse('https://app.kilo.ai/users/sign_in?error=TURNSTILE_REQUIRED')
    );
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe(`/organizations/${ORG_ID}/byok`);
    expect(location.searchParams.get('openai_error')).toBe('TURNSTILE_REQUIRED');
  });

  test('leaves a code-free app sign-in redirect unchanged', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    // The app sign-in route is shared with the plain sign-in flow, so a redirect
    // there without a failure code is not a connect failure.
    const nextAuthResponse = redirectResponse('https://app.kilo.ai/users/sign_in');
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    expect(response).toBe(nextAuthResponse);
    expect(mockGetUserFromSession).not.toHaveBeenCalled();
  });

  test('leaves the app sign-in hop untouched without a session', async () => {
    mockGetUserFromSession.mockResolvedValue(null);
    const nextAuthResponse = redirectResponse(
      'https://app.kilo.ai/users/sign_in?error=TURNSTILE_REQUIRED'
    );
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    expect(response).toBe(nextAuthResponse);
    expect(response.headers.get('location')).toBe(
      'https://app.kilo.ai/users/sign_in?error=TURNSTILE_REQUIRED'
    );
  });

  test('leaves an error hop without a failure code unchanged', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    const nextAuthResponse = redirectResponse('https://app.kilo.ai/api/auth/error');
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    expect(response).toBe(nextAuthResponse);
    expect(mockGetUserFromSession).not.toHaveBeenCalled();
  });

  test('leaves the internal callback failure on the sign-in path without a session', async () => {
    mockGetUserFromSession.mockResolvedValue(null);
    const nextAuthResponse = redirectResponse(
      'https://app.kilo.ai/api/auth/error?error=OAuthCallback'
    );
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    expect(response).toBe(nextAuthResponse);
    expect(response.headers.get('location')).toBe(
      'https://app.kilo.ai/api/auth/error?error=OAuthCallback'
    );
  });

  test('leaves the bare sign-in hop on the sign-in path without a session', async () => {
    mockGetUserFromSession.mockResolvedValue(null);
    const nextAuthResponse = redirectResponse('http://localhost:3000/api/auth/signin');
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    expect(response).toBe(nextAuthResponse);
    expect(response.headers.get('location')).toBe('http://localhost:3000/api/auth/signin');
  });

  test('returns a successful callback redirect unchanged', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    const nextAuthResponse = redirectResponse('https://app.kilo.ai/byok');
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    expect(response).toBe(nextAuthResponse);
    expect(mockGetUserFromSession).not.toHaveBeenCalled();
  });

  test('returns a non-redirect callback response unchanged', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    const nextAuthResponse = new Response(null, { status: 200 });
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    const response = await GET(request, {});

    expect(response).toBe(nextAuthResponse);
  });

  test('does not rewrite an auth error response for a request without a code', async () => {
    mockGetUserFromSession.mockResolvedValue({ id: 'user-1' });
    const nextAuthResponse = redirectResponse(
      'https://app.kilo.ai/api/auth/error?error=OAuthCallback'
    );
    mockNextAuthHttpHandler.mockResolvedValue(nextAuthResponse);
    const request = new NextRequest(`${CALLBACK_URL}?state=the-state`);

    const response = await GET(request, {});

    expect(response).toBe(nextAuthResponse);
    expect(mockGetUserFromSession).not.toHaveBeenCalled();
  });
});
