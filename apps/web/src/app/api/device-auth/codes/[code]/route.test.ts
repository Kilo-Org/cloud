process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import { NextRequest } from 'next/server';

jest.mock('@/lib/device-auth/device-auth');
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/device-auth/device-auth-viewer-token');
jest.mock('@vercel/firewall');
jest.mock('@sentry/nextjs');

import {
  denyDeviceAuthRequest,
  getDeviceAuthRequest,
  isDeviceAuthRequestExpired,
} from '@/lib/device-auth/device-auth';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { verifyDeviceAuthViewerToken } from '@/lib/device-auth/device-auth-viewer-token';
import { checkRateLimit } from '@vercel/firewall';
import { GET, DELETE } from './route';

const mockGet = jest.mocked(getDeviceAuthRequest);
const mockDeny = jest.mocked(denyDeviceAuthRequest);
const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockVerifyToken = jest.mocked(verifyDeviceAuthViewerToken);
const mockCheckRateLimit = jest.mocked(checkRateLimit);

const fakeUser = { id: 'user-1' } as never;

const SAMPLE_CODE = 'test-code';
const SAMPLE_URL = 'https://example.com';

describe('GET /api/device-auth/codes/[code] (status only)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The route reads expiry through the helper; mirror the real rule here.
    jest
      .mocked(isDeviceAuthRequestExpired)
      .mockImplementation(
        request => new Date(request.expires_at) < new Date() || request.status === 'expired'
      );
  });

  test('reports 202 pending for an unapproved request', async () => {
    mockGet.mockResolvedValue({
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    const response = await GET(new NextRequest(SAMPLE_URL), {
      params: Promise.resolve({ code: SAMPLE_CODE }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  test('reports 202 pending for an approved request', async () => {
    mockGet.mockResolvedValue({
      status: 'approved',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    const response = await GET(new NextRequest(SAMPLE_URL), {
      params: Promise.resolve({ code: SAMPLE_CODE }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('pending');
    expect(body).toEqual({ status: 'pending' });
  });

  test('reports 403 denied', async () => {
    mockGet.mockResolvedValue({
      status: 'denied',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    const response = await GET(new NextRequest(SAMPLE_URL), {
      params: Promise.resolve({ code: SAMPLE_CODE }),
    });
    expect(response.status).toBe(403);
  });

  test('reports 410 expired', async () => {
    mockGet.mockResolvedValue({
      status: 'expired',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);

    const response = await GET(new NextRequest(SAMPLE_URL), {
      params: Promise.resolve({ code: SAMPLE_CODE }),
    });
    expect(response.status).toBe(410);
  });

  test('reports 410 expired for a consumed request', async () => {
    mockGet.mockResolvedValue({
      status: 'consumed',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    const response = await GET(new NextRequest(SAMPLE_URL), {
      params: Promise.resolve({ code: SAMPLE_CODE }),
    });
    expect(response.status).toBe(410);
  });

  test('reports 410 expired for a code with no row', async () => {
    mockGet.mockResolvedValue(undefined as never);

    const response = await GET(new NextRequest(SAMPLE_URL), {
      params: Promise.resolve({ code: SAMPLE_CODE }),
    });
    expect(response.status).toBe(410);
  });

  test('reports 400 for a missing code', async () => {
    const response = await GET(new NextRequest(SAMPLE_URL), {
      params: Promise.resolve({ code: '' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/device-auth/codes/[code] (deny with viewer token)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({ user: fakeUser, authFailedResponse: null });
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false } as never);
  });

  function createRequest(code: string, headers?: Record<string, string>) {
    return new NextRequest(`http://localhost:3000/api/device-auth/codes/${code}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  test('returns 200 on successful deny', async () => {
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'user-1' });

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockDeny).toHaveBeenCalledWith('ABCD-EFGH');
  });

  test('returns 403 without viewer token', async () => {
    mockVerifyToken.mockReturnValue(null);

    const response = await DELETE(createRequest('ABCD-EFGH'), {
      params: Promise.resolve({ code: SAMPLE_CODE }),
    });
    expect(response.status).toBe(403);
    expect(response.statusText).toBeDefined(); // invalid or expired
    expect(mockDeny).not.toHaveBeenCalled();
  });

  test('returns 403 when viewer token code does not match route code', async () => {
    mockVerifyToken.mockReturnValue({ code: 'DIFFERENT', userId: 'user-1' });

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(403);
    expect(mockDeny).not.toHaveBeenCalled();
  });

  test('returns 403 when viewer token userId does not match authenticated user', async () => {
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'different-user' });

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(403);
    expect(mockDeny).not.toHaveBeenCalled();
  });

  test('returns 401 when user is not authenticated', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    } as never);

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(401);
  });

  test('returns 429 when rate limited', async () => {
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'user-1' });
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true } as never);

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(429);
    expect(mockDeny).not.toHaveBeenCalled();
  });

  test('returns 400 for missing code', async () => {
    const response = await DELETE(createRequest(''), { params: Promise.resolve({ code: '' }) });
    expect(response.status).toBe(400);
  });

  test('returns 409 on second deny (controlled refusal, not 500)', async () => {
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'user-1' });
    mockDeny.mockRejectedValue(new Error('Device authorization request is not pending'));

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Device authorization request can no longer be denied',
    });
    expect(mockDeny).toHaveBeenCalledWith('ABCD-EFGH');
  });

  test('returns 404 when deny targets a non-existent request', async () => {
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'user-1' });
    mockDeny.mockRejectedValue(new Error('Device authorization request not found'));

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
});
