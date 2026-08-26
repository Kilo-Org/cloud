import { beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { MediaProxyError } from '@/lib/media-proxy';
import { GET, MEDIA_SOURCE_HEADER } from './route';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/config.server', () => ({ NEXTAUTH_SECRET: 'test-secret' }));
jest.mock('@/lib/media-proxy', () => {
  class TestMediaProxyError extends Error {}
  return { fetchSafeMedia: jest.fn(), MediaProxyError: TestMediaProxyError };
});

const { captureException } = jest.requireMock('@sentry/nextjs');
const { checkRateLimit } = jest.requireMock('@vercel/firewall');
const { getUserFromAuth } = jest.requireMock('@/lib/user/server');
const { fetchSafeMedia } = jest.requireMock('@/lib/media-proxy');

const mockCaptureException = jest.mocked(captureException);
const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockFetchSafeMedia = jest.mocked(fetchSafeMedia);

const SOURCE_URL = 'https://example.com/a.png';

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('https://app.test/api/media/proxy?id=m0', { headers });
}

function authorizedRequest(): NextRequest {
  return makeRequest({ authorization: 'Bearer token', [MEDIA_SOURCE_HEADER]: SOURCE_URL });
}

describe('GET /api/media/proxy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({ user: { id: 'user-1' }, authFailedResponse: null });
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
  });

  it('rejects a request with no Authorization header before touching auth', async () => {
    const response = await GET(makeRequest({ [MEDIA_SOURCE_HEADER]: SOURCE_URL }));

    expect(response.status).toBe(401);
    expect(mockGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockFetchSafeMedia).not.toHaveBeenCalled();
  });

  it('short-circuits on an auth failure', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(401);
    expect(mockFetchSafeMedia).not.toHaveBeenCalled();
  });

  it('returns 429 when the user is rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(429);
    expect(mockFetchSafeMedia).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'media-proxy',
      expect.objectContaining({ rateLimitKey: expect.any(String) })
    );
  });

  it('never sends the raw user id to the rate limiter', async () => {
    await GET(authorizedRequest());

    const options = mockCheckRateLimit.mock.calls[0]?.[1] as { rateLimitKey: string };
    expect(options.rateLimitKey).not.toContain('user-1');
  });

  it('returns 400 when the source header is missing', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer token' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: `Missing ${MEDIA_SOURCE_HEADER} header`,
    });
    expect(mockFetchSafeMedia).not.toHaveBeenCalled();
  });

  it('reads the source URL from the header, not the query string', async () => {
    mockFetchSafeMedia.mockResolvedValue(new Response('ok'));

    await GET(authorizedRequest());

    expect(mockFetchSafeMedia).toHaveBeenCalledWith(SOURCE_URL);
  });

  it('passes the proxied response through untouched', async () => {
    const proxied = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=300' },
    });
    mockFetchSafeMedia.mockResolvedValue(proxied);

    const response = await GET(authorizedRequest());

    expect(response).toBe(proxied);
  });

  it('maps a MediaProxyError to 400 with its message', async () => {
    mockFetchSafeMedia.mockRejectedValue(
      new MediaProxyError('Media URL host resolves to a non-public address.')
    );

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Media URL host resolves to a non-public address.',
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('maps any other failure to a generic 502 and reports it', async () => {
    const failure = new TypeError('fetch failed');
    mockFetchSafeMedia.mockRejectedValue(failure);

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'Media proxy failed.' });
    expect(mockCaptureException).toHaveBeenCalledWith(failure);
  });

  it('does not leak an upstream timeout message to the client', async () => {
    mockFetchSafeMedia.mockRejectedValue(
      new Error('TimeoutError: The operation was aborted due to timeout')
    );

    const response = await GET(authorizedRequest());

    await expect(response.json()).resolves.toEqual({ error: 'Media proxy failed.' });
  });
});
