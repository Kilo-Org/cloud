import { NextRequest } from 'next/server';

jest.mock('@/lib/user/server');
jest.mock('@/lib/auth/device-sessions');

import { POST } from './route';
import { getUserFromAuth } from '@/lib/user/server';
import { createDeviceSession, issueSessionCredentials } from '@/lib/auth/device-sessions';
import type { User } from '@kilocode/db/schema';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockCreateDeviceSession = jest.mocked(createDeviceSession);
const mockIssueSessionCredentials = jest.mocked(issueSessionCredentials);

const fakeUser = { id: 'user-1', api_token_pepper: 'pepper' } as User;

describe('POST /api/auth/native/exchange', () => {
  const createRequest = () =>
    new NextRequest('http://localhost:3000/api/auth/native/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer old-token' },
    });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 200 with short-lived pair when authenticated', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: fakeUser,
      authFailedResponse: null,
    });
    mockCreateDeviceSession.mockResolvedValue('session-1');
    mockIssueSessionCredentials.mockResolvedValue({
      token: 'short-jwt',
      refreshToken: 'refresh-abc',
      expiresIn: 3600,
    });

    const response = await POST(createRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: 'short-jwt',
      refreshToken: 'refresh-abc',
      expiresIn: 3600,
    });
    expect(mockCreateDeviceSession).toHaveBeenCalledWith({
      userId: fakeUser.id,
      userAgent: undefined,
    });
    expect(mockIssueSessionCredentials).toHaveBeenCalledWith(fakeUser, 'session-1');
  });

  it('returns the auth failed response when token is invalid', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }) as any,
    });

    const response = await POST(createRequest());
    expect(response.status).toBe(401);
  });

  it('does not call createDeviceSession when auth fails', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }) as any,
    });

    await POST(createRequest());
    expect(mockCreateDeviceSession).not.toHaveBeenCalled();
  });
});
