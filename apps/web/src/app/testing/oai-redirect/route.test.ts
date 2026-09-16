const mockNextAuthHttpHandler = jest.fn<Promise<Response>, [NextRequest, unknown]>();
const mockGetUserFromSession = jest.fn<Promise<{ id: string } | null>, []>();

jest.mock('@/lib/user/server', () => ({
  nextAuthHttpHandler: (...args: [NextRequest, unknown]) => mockNextAuthHttpHandler(...args),
  getUserFromSession: () => mockGetUserFromSession(),
}));

import { NextRequest } from 'next/server';
import { GET } from './route';

const CALLBACK_URL = 'https://app.kilo.ai/testing/oai-redirect';

beforeEach(() => {
  jest.clearAllMocks();
  mockNextAuthHttpHandler.mockResolvedValue(new Response(null, { status: 200 }));
});

function forwardedRequest(): NextRequest | undefined {
  return mockNextAuthHttpHandler.mock.calls[0]?.[0];
}

describe('GET /testing/oai-redirect', () => {
  test('rewrites the registered callback path to the next-auth openai callback', async () => {
    mockGetUserFromSession.mockResolvedValue(null);
    const request = new NextRequest(`${CALLBACK_URL}?code=the-code&state=the-state`);

    await GET(request, {});

    expect(mockNextAuthHttpHandler).toHaveBeenCalledTimes(1);
    expect(forwardedRequest()?.nextUrl.pathname).toBe('/api/auth/callback/openai');
    expect(forwardedRequest()?.nextUrl.searchParams.get('code')).toBe('the-code');
    expect(forwardedRequest()?.nextUrl.searchParams.get('state')).toBe('the-state');
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

  test('falls through to next-auth on a callback error without a session', async () => {
    mockGetUserFromSession.mockResolvedValue(null);
    const request = new NextRequest(`${CALLBACK_URL}?error=access_denied&state=the-state`);

    await GET(request, {});

    expect(mockNextAuthHttpHandler).toHaveBeenCalledTimes(1);
    expect(forwardedRequest()?.nextUrl.pathname).toBe('/api/auth/callback/openai');
    expect(forwardedRequest()?.nextUrl.searchParams.get('error')).toBe('access_denied');
  });
});
