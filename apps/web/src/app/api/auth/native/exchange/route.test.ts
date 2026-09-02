import { NextRequest, NextResponse } from 'next/server';
import { failureResult } from '@/lib/maybe-result';
import { APP_URL } from '@/lib/constants';

jest.mock('@/lib/user/server', () => ({
  getUserFromBearerForCredentialExchange: jest.fn(),
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));
jest.mock('@/lib/auth/device-sessions');

import { POST } from './route';
import {
  getUserFromBearerForCredentialExchange,
  getUserFromSessionForCredentialIssuance,
} from '@/lib/user/server';
import { createDeviceSession, issueSessionCredentials } from '@/lib/auth/device-sessions';
import type { User } from '@kilocode/db/schema';

const mockGetUserFromBearer = jest.mocked(getUserFromBearerForCredentialExchange);
const mockGetUserFromSession = jest.mocked(getUserFromSessionForCredentialIssuance);
const mockCreateDeviceSession = jest.mocked(createDeviceSession);
const mockIssueSessionCredentials = jest.mocked(issueSessionCredentials);

const fakeUser = { id: 'user-1', api_token_pepper: 'pepper' } as User;

describe('POST /api/auth/native/exchange', () => {
  const createRequest = (headers: Record<string, string> = {}) =>
    new NextRequest('http://localhost:3000/api/auth/native/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    });

  const bearerHeaders = { Authorization: 'Bearer old-token' };
  const sessionHeaders = { Origin: new URL(APP_URL).origin };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 200 with short-lived pair when authenticated', async () => {
    mockGetUserFromBearer.mockResolvedValue({
      user: fakeUser,
      authFailedResponse: null,
    });
    mockCreateDeviceSession.mockResolvedValue('session-1');
    mockIssueSessionCredentials.mockResolvedValue({
      token: 'short-jwt',
      refreshToken: 'refresh-abc',
      expiresIn: 3600,
    });

    const response = await POST(createRequest(bearerHeaders));
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
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockGetUserFromBearer).toHaveBeenCalledWith(expect.any(Headers), {
      legacy: 'five-year-api',
    });
    expect(mockGetUserFromSession).not.toHaveBeenCalled();
  });

  it('returns the bearer failure without falling back to a session', async () => {
    mockGetUserFromBearer.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Invalid token'), { status: 401 }),
    });

    const response = await POST(createRequest(bearerHeaders));
    expect(response.status).toBe(401);
    expect(mockGetUserFromSession).not.toHaveBeenCalled();
    expect(mockCreateDeviceSession).not.toHaveBeenCalled();
    expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
  });

  it('does not issue credentials when the bearer user is blocked', async () => {
    mockGetUserFromBearer.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('User blocked'), { status: 403 }),
    });

    const response = await POST(createRequest(bearerHeaders));
    expect(response.status).toBe(403);
    expect(mockCreateDeviceSession).not.toHaveBeenCalled();
    expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
  });

  it('rejects a cookie request with no origin before authenticating', async () => {
    const response = await POST(createRequest());

    expect(response.status).toBe(403);
    expect(mockGetUserFromSession).not.toHaveBeenCalled();
    expect(mockCreateDeviceSession).not.toHaveBeenCalled();
    expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
  });

  it('rejects a cookie request with a foreign origin before authenticating', async () => {
    const response = await POST(createRequest({ Origin: 'https://evil.example' }));

    expect(response.status).toBe(403);
    expect(mockGetUserFromSession).not.toHaveBeenCalled();
    expect(mockCreateDeviceSession).not.toHaveBeenCalled();
    expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
  });

  it('issues credentials for a same-origin authenticated browser session', async () => {
    mockGetUserFromSession.mockResolvedValue({ user: fakeUser, authFailedResponse: null });
    mockCreateDeviceSession.mockResolvedValue('session-1');
    mockIssueSessionCredentials.mockResolvedValue({
      token: 'short-jwt',
      refreshToken: 'refresh-abc',
      expiresIn: 3600,
    });

    const response = await POST(createRequest(sessionHeaders));

    expect(response.status).toBe(200);
    expect(mockGetUserFromSession).toHaveBeenCalledWith();
    expect(mockGetUserFromBearer).not.toHaveBeenCalled();
    expect(mockCreateDeviceSession).toHaveBeenCalledWith({
      userId: fakeUser.id,
      userAgent: undefined,
    });
    expect(mockIssueSessionCredentials).toHaveBeenCalledWith(fakeUser, 'session-1');
  });
});
