import { NextRequest, NextResponse } from 'next/server';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import { APP_URL } from '@kilocode/web-shared/lib/constants';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromBearerForCredentialExchange: jest.fn(),
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));
jest.mock('@/lib/auth/device-sessions');
jest.mock('@/lib/auth/native-admission', () => ({
  ...jest.requireActual('@/lib/auth/native-admission'),
  requireAdmissionPayload: jest.fn(),
  verifyAdmissionAsync: jest.fn(),
}));

import { POST } from './route';
import {
  getUserFromBearerForCredentialExchange,
  getUserFromSessionForCredentialIssuance,
} from '@kilocode/web-shared/lib/user/server';
import {
  createDeviceSession,
  createDeviceSessionWithAttestedKey,
  issueSessionCredentials,
} from '@/lib/auth/device-sessions';
import {
  KeyCollisionError,
  requireAdmissionPayload,
  verifyAdmissionAsync,
} from '@/lib/auth/native-admission';
import type { User } from '@kilocode/db/schema';

const mockGetUserFromBearer = jest.mocked(getUserFromBearerForCredentialExchange);
const mockGetUserFromSession = jest.mocked(getUserFromSessionForCredentialIssuance);
const mockCreateDeviceSession = jest.mocked(createDeviceSession);
const mockCreateDeviceSessionWithAttestedKey = jest.mocked(createDeviceSessionWithAttestedKey);
const mockIssueSessionCredentials = jest.mocked(issueSessionCredentials);
const mockRequireAdmissionPayload = jest.mocked(requireAdmissionPayload);
const mockVerifyAdmissionAsync = jest.mocked(verifyAdmissionAsync);

const fakeUser = { id: 'user-1', api_token_pepper: 'pepper' } as User;

describe('POST /api/auth/native/exchange', () => {
  const createRequest = (headers: Record<string, string> = {}) =>
    new NextRequest('http://localhost:3000/api/auth/native/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ admission: { platform: 'android' } }),
    });

  const bearerHeaders = { Authorization: 'Bearer old-token' };
  const sessionHeaders = { Origin: new URL(APP_URL).origin };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateDeviceSessionWithAttestedKey.mockReset();
    mockRequireAdmissionPayload.mockReturnValue({
      platform: 'android',
      kind: 'assertion',
      challenge: 'challenge',
      payload: 'integrity-token',
    });
    mockVerifyAdmissionAsync.mockResolvedValue({ ok: true, platform: 'android', keyId: '' });
  });

  it('refuses a request with no proof before reading any credential', async () => {
    mockRequireAdmissionPayload.mockReturnValue(undefined);

    const response = await POST(createRequest(bearerHeaders));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
    expect(mockVerifyAdmissionAsync).not.toHaveBeenCalled();
    expect(mockGetUserFromBearer).not.toHaveBeenCalled();
    expect(mockGetUserFromSession).not.toHaveBeenCalled();
    expect(mockCreateDeviceSession).not.toHaveBeenCalled();
  });

  it('refuses a device the verifier rejects', async () => {
    mockVerifyAdmissionAsync.mockResolvedValue({ ok: false, errorCode: 'ADMISSION_REQUIRED' });

    const response = await POST(createRequest(bearerHeaders));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
    expect(mockGetUserFromBearer).not.toHaveBeenCalled();
    expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
  });

  it('reports a provider outage as a retryable 500', async () => {
    mockVerifyAdmissionAsync.mockRejectedValue(new Error('provider unavailable'));

    const response = await POST(createRequest(bearerHeaders));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'INTERNAL_ERROR' });
    expect(mockGetUserFromBearer).not.toHaveBeenCalled();
    expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
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

  it('binds a verified iOS key and creates the session in one call', async () => {
    mockRequireAdmissionPayload.mockReturnValue({
      platform: 'ios',
      kind: 'attestation',
      challenge: 'challenge',
      payload: 'attestation-object',
      keyId: 'ios-key',
    });
    mockVerifyAdmissionAsync.mockResolvedValue({
      ok: true,
      platform: 'ios',
      keyId: 'ios-key',
      publicKey: 'spki',
    });
    mockGetUserFromBearer.mockResolvedValue({ user: fakeUser, authFailedResponse: null });
    mockCreateDeviceSessionWithAttestedKey.mockResolvedValue({
      token: 'short-jwt',
      refreshToken: 'refresh-abc',
      expiresIn: 3600,
      sessionId: 'session-1',
    });

    const response = await POST(createRequest(bearerHeaders));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: 'short-jwt',
      refreshToken: 'refresh-abc',
      expiresIn: 3600,
    });
    expect(mockCreateDeviceSessionWithAttestedKey).toHaveBeenCalledWith({
      userId: fakeUser.id,
      userAgent: undefined,
      user: fakeUser,
      verification: { ok: true, platform: 'ios', keyId: 'ios-key', publicKey: 'spki' },
    });
    expect(mockCreateDeviceSession).not.toHaveBeenCalled();
    expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
  });

  it('refuses a key that belongs to another account', async () => {
    mockVerifyAdmissionAsync.mockResolvedValue({
      ok: true,
      platform: 'ios',
      keyId: 'ios-key',
      existingKeyUserId: 'user-2',
    });
    mockGetUserFromBearer.mockResolvedValue({ user: fakeUser, authFailedResponse: null });

    const response = await POST(createRequest(bearerHeaders));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
    expect(mockCreateDeviceSessionWithAttestedKey).not.toHaveBeenCalled();
    expect(mockCreateDeviceSession).not.toHaveBeenCalled();
    expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
  });

  it('refuses when the key row collides with another account', async () => {
    mockVerifyAdmissionAsync.mockResolvedValue({ ok: true, platform: 'ios', keyId: 'ios-key' });
    mockGetUserFromBearer.mockResolvedValue({ user: fakeUser, authFailedResponse: null });
    mockCreateDeviceSessionWithAttestedKey.mockRejectedValue(new KeyCollisionError());

    const response = await POST(createRequest(bearerHeaders));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
    expect(mockCreateDeviceSession).not.toHaveBeenCalled();
    expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
  });

  it('reports a key persistence failure instead of issuing an unbound credential', async () => {
    mockVerifyAdmissionAsync.mockResolvedValue({ ok: true, platform: 'ios', keyId: 'ios-key' });
    mockGetUserFromBearer.mockResolvedValue({ user: fakeUser, authFailedResponse: null });
    mockCreateDeviceSessionWithAttestedKey.mockRejectedValue(new Error('db unavailable'));

    const response = await POST(createRequest(bearerHeaders));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'INTERNAL_ERROR' });
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
