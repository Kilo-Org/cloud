process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import { NextRequest } from 'next/server';

jest.mock('@/lib/device-auth/device-auth');
jest.mock('@/lib/user/server');
jest.mock('@/lib/device-auth/device-auth-viewer-token');
jest.mock('@vercel/firewall');
jest.mock('@sentry/nextjs');

import { pollDeviceAuthRequest, denyDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { getUserFromAuth } from '@/lib/user/server';
import { verifyDeviceAuthViewerToken } from '@/lib/device-auth/device-auth-viewer-token';
import { checkRateLimit } from '@vercel/firewall';
import { GET, DELETE } from './route';

const mockPoll = jest.mocked(pollDeviceAuthRequest);
const mockDeny = jest.mocked(denyDeviceAuthRequest);
const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockVerifyToken = jest.mocked(verifyDeviceAuthViewerToken);
const mockCheckRateLimit = jest.mocked(checkRateLimit);

const fakeUser = { id: 'user-1' } as never;

describe('GET /api/device-auth/codes/[code] (legacy poll)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 202 for pending', async () => {
    mockPoll.mockResolvedValue({ status: 'pending' });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ code: 'ABCD-EFGH' }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  test('returns 200 with token for approved', async () => {
    mockPoll.mockResolvedValue({
      status: 'approved',
      token: 'jwt',
      userId: 'user-1',
      userEmail: 'user@example.com',
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ code: 'ABCD-EFGH' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'approved',
      token: 'jwt',
      userId: 'user-1',
      userEmail: 'user@example.com',
    });
  });

  test('returns 403 for denied', async () => {
    mockPoll.mockResolvedValue({ status: 'denied' });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ code: 'ABCD-EFGH' }),
    });
    expect(response.status).toBe(403);
  });

  test('returns 410 for expired', async () => {
    mockPoll.mockResolvedValue({ status: 'expired' });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ code: 'ABCD-EFGH' }),
    });
    expect(response.status).toBe(410);
  });

  test('returns 400 for missing code', async () => {
    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ code: '' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/device-auth/codes/[code] (deny with viewer token)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({ user: fakeUser, authFailedResponse: undefined });
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
      params: Promise.resolve({ code: 'ABCD-EFGH' }),
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
      user: undefined as never,
      authFailedResponse: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    });

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
