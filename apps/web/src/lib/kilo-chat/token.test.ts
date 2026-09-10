import type { User } from '@kilocode/db/schema';
import jwt from 'jsonwebtoken';
import type { ResourceDelegationAuthority } from '@/lib/auth/resource-delegation';
import { getResourceDelegationAuthority } from '@/lib/auth/resource-delegation';
import { isResourceTokenIssuanceEnabled, NEXTAUTH_SECRET } from '@/lib/config.server';
import { generateApiToken } from '@/lib/tokens';
import {
  EVENT_SERVICE_AUDIENCE,
  KILO_CHAT_AUDIENCE,
  NOTIFICATIONS_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { createKiloChatTokenResponse } from './token';

jest.mock('@/lib/auth/resource-delegation', () => ({ getResourceDelegationAuthority: jest.fn() }));
jest.mock('@/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'chat-token-unit-test-secret',
  isResourceTokenIssuanceEnabled: jest.fn(),
}));
jest.mock('@/lib/tokens', () => ({ generateApiToken: jest.fn() }));

const now = 1_800_000_000;
const user = { id: 'oauth/chat-user', api_token_pepper: 'test-pepper' } as User;
const mockAuthority = jest.mocked(getResourceDelegationAuthority);
const mockFlag = jest.mocked(isResourceTokenIssuanceEnabled);
const mockLegacyToken = jest.mocked(generateApiToken);

function authority(
  overrides: Partial<ResourceDelegationAuthority> = {}
): ResourceDelegationAuthority {
  return {
    user,
    credentialKind: 'device-access',
    isModern: true,
    deviceSessionId: 'active-device-session',
    expiresAt: now + 600,
    runtimeAdmission: {
      source: 'user',
      authorizationUserId: user.id,
      authorizationPepper: user.api_token_pepper,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers().setSystemTime(now * 1000);
  mockFlag.mockReturnValue(false);
  mockAuthority.mockResolvedValue(authority());
  mockLegacyToken.mockReturnValue('legacy-token');
});
afterEach(() => jest.useRealTimers());

it.each([
  [false, 600, 600],
  [false, 7200, 3600],
  [true, 600, 600],
  [true, 7200, 3600],
])('signs device chat tokens (flag=%s, parent TTL=%s)', async (enabled, parentTtl, expectedTtl) => {
  mockFlag.mockReturnValue(enabled);
  mockAuthority.mockResolvedValue(authority({ expiresAt: now + parentTtl }));
  const headers = new Headers({ authorization: 'Bearer test-device-credential' });
  const result = await createKiloChatTokenResponse(user, headers);
  expect(jwt.verify(result.token, NEXTAUTH_SECRET, { algorithms: ['HS256'] })).toEqual({
    version: 3,
    kiloUserId: user.id,
    apiTokenPepper: user.api_token_pepper,
    env: 'test',
    aud: [KILO_CHAT_AUDIENCE, EVENT_SERVICE_AUDIENCE, NOTIFICATIONS_AUDIENCE],
    iat: now,
    exp: now + expectedTtl,
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    tokenSource: 'kilo-chat',
  });
  expect(result.expiresAt).toBe(new Date((now + expectedTtl) * 1000).toISOString());
  expect(result.userId).toBe(user.id);
  expect(mockAuthority).toHaveBeenCalledWith(user, { headers });
  expect(mockFlag).toHaveBeenCalledWith('chat');
  expect(mockLegacyToken).not.toHaveBeenCalled();
});

it.each(['human-api', 'device-access'] as const)(
  'preserves flags-off legacy %s issuance and expiry cap',
  async credentialKind => {
    mockAuthority.mockResolvedValue(
      authority({ credentialKind, isModern: false, deviceSessionId: undefined })
    );
    await expect(createKiloChatTokenResponse(user)).resolves.toEqual({
      token: 'legacy-token',
      expiresAt: new Date((now + 600) * 1000).toISOString(),
      userId: user.id,
    });
    expect(mockLegacyToken).toHaveBeenCalledWith(
      user,
      { tokenSource: 'kilo-chat' },
      { expiresIn: 600 }
    );
  }
);

it.each([
  { credentialKind: 'human-api' as const },
  { deviceSessionId: undefined },
  { deviceSessionId: '' },
])('denies unsupported modern authority after rollback: %j', async overrides => {
  mockAuthority.mockResolvedValue(authority(overrides));
  await expect(createKiloChatTokenResponse(user)).rejects.toThrow(
    'Shared resource token migration is unavailable'
  );
  expect(mockLegacyToken).not.toHaveBeenCalled();
});

it.each([0, -1])('denies expired device authority (remaining TTL=%s)', async remaining => {
  mockAuthority.mockResolvedValue(authority({ expiresAt: now + remaining }));
  await expect(createKiloChatTokenResponse(user)).rejects.toThrow(
    'Kilo Chat delegation authority has expired'
  );
  expect(mockLegacyToken).not.toHaveBeenCalled();
});

it('propagates authority validation errors without issuing a token', async () => {
  const error = new Error('Device session revoked');
  mockAuthority.mockRejectedValue(error);
  await expect(createKiloChatTokenResponse(user)).rejects.toBe(error);
  expect(mockFlag).not.toHaveBeenCalled();
  expect(mockLegacyToken).not.toHaveBeenCalled();
});

it.each(['delegated-workload', 'internal-service'] as const)(
  'rejects modern %s without issuing legacy credentials',
  async credentialKind => {
    mockAuthority.mockResolvedValue(
      authority({ credentialKind: credentialKind as ResourceDelegationAuthority['credentialKind'] })
    );
    await expect(createKiloChatTokenResponse(user)).rejects.toThrow(
      'Kilo Chat requires a fresh user credential'
    );
    expect(mockLegacyToken).not.toHaveBeenCalled();
  }
);
