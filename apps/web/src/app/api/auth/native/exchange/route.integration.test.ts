const mockHeaders = jest.fn<Promise<Headers>, []>();
const mockGetServerSession = jest.fn();
const mockCreateDeviceSession = jest.fn();
const mockIssueSessionCredentials = jest.fn();

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));

jest.mock('next-auth', () => ({
  __esModule: true,
  ...jest.requireActual('next-auth'),
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock('@/lib/auth/device-sessions', () => ({
  createDeviceSession: (...args: unknown[]) => mockCreateDeviceSession(...args),
  issueSessionCredentials: (...args: unknown[]) => mockIssueSessionCredentials(...args),
}));

import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { POST } from './route';
import { APP_URL } from '@/lib/constants';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';

const credentials = {
  token: 'short-lived-token',
  refreshToken: 'refresh-token',
  expiresIn: 3600,
};

function createRequest(headers: Record<string, string> = {}) {
  return new NextRequest(`${APP_URL}/api/auth/native/exchange`, {
    method: 'POST',
    headers,
  });
}

function setCurrentSession(userId: string, webSessionPepper: string | null) {
  mockHeaders.mockResolvedValue(new Headers({ Cookie: 'next-auth.session-token=valid-cookie' }));
  mockGetServerSession.mockResolvedValue({ kiloUserId: userId, webSessionPepper });
}

function expectNoCredentialsIssued() {
  expect(mockCreateDeviceSession).not.toHaveBeenCalled();
  expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
}

describe('POST /api/auth/native/exchange integration', () => {
  beforeEach(() => {
    mockHeaders.mockReset();
    mockGetServerSession.mockReset();
    mockCreateDeviceSession.mockReset();
    mockIssueSessionCredentials.mockReset();
  });

  test('exchanges a legacy generated API token with a null pepper and device authorization code', async () => {
    const user = await insertTestUser({ api_token_pepper: null });
    const token = generateApiToken(user, { deviceAuthRequestCode: 'ABCD-EFGH' });
    mockCreateDeviceSession.mockResolvedValue('device-session-id');
    mockIssueSessionCredentials.mockResolvedValue(credentials);

    const response = await POST(createRequest({ Authorization: `Bearer ${token}` }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(credentials);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockCreateDeviceSession).toHaveBeenCalledWith({
      userId: user.id,
      userAgent: undefined,
    });
    expect(mockIssueSessionCredentials).toHaveBeenCalledWith(user, 'device-session-id');
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  test.each([
    [
      'one-hour legacy token',
      (user: Awaited<ReturnType<typeof insertTestUser>>) =>
        generateApiToken(user, undefined, { expiresIn: TOKEN_EXPIRY.oneHour }),
    ],
    [
      'device-session access token',
      (user: Awaited<ReturnType<typeof insertTestUser>>) =>
        generateApiToken(
          user,
          { deviceSessionId: crypto.randomUUID() },
          { expiresIn: TOKEN_EXPIRY.oneHour }
        ),
    ],
    [
      'worker audience token',
      (user: Awaited<ReturnType<typeof insertTestUser>>) =>
        jwt.sign(
          {
            version: 3,
            kiloUserId: user.id,
            apiTokenPepper: user.api_token_pepper,
            env: process.env.NODE_ENV,
            aud: KILO_GATEWAY_AUDIENCE,
          },
          NEXTAUTH_SECRET,
          { algorithm: 'HS256', expiresIn: TOKEN_EXPIRY.oneHour }
        ),
    ],
    [
      'cloud-agent token',
      (user: Awaited<ReturnType<typeof insertTestUser>>) =>
        generateApiToken(user, { tokenSource: 'cloud-agent' }),
    ],
  ])('rejects a %s without issuing credentials', async (_name, createToken) => {
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const response = await POST(createRequest({ Authorization: `Bearer ${createToken(user)}` }));

    expect(response.status).toBe(401);
    expectNoCredentialsIssued();
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  test.each([
    ['empty', ''],
    ['malformed', 'Basic not-a-bearer-token'],
  ])(
    'does not fall back to a valid cookie for an %s authorization header',
    async (_name, authorization) => {
      const user = await insertTestUser({ web_session_pepper: 'current-session-pepper' });
      setCurrentSession(user.id, user.web_session_pepper);

      const response = await POST(
        createRequest({
          Authorization: authorization,
          Cookie: 'next-auth.session-token=valid-cookie',
        })
      );

      expect(response.status).toBe(401);
      expectNoCredentialsIssued();
      expect(mockGetServerSession).not.toHaveBeenCalled();
    }
  );

  test('does not issue credentials for a same-origin revoked session', async () => {
    const user = await insertTestUser({ web_session_pepper: 'current-session-pepper' });
    setCurrentSession(user.id, 'revoked-session-pepper');

    const response = await POST(
      createRequest({
        Origin: new URL(APP_URL).origin,
        Cookie: 'next-auth.session-token=valid-cookie',
      })
    );

    expect(response.status).toBe(401);
    expectNoCredentialsIssued();
  });

  test('does not issue credentials for a same-origin blocked session', async () => {
    const user = await insertTestUser({ blocked_reason: 'blocked for integration test' });
    setCurrentSession(user.id, null);

    const response = await POST(
      createRequest({
        Origin: new URL(APP_URL).origin,
        Cookie: 'next-auth.session-token=valid-cookie',
      })
    );

    expect(response.status).toBe(403);
    expectNoCredentialsIssued();
  });
});
