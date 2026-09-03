import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import {
  API_GATEWAY_CREDENTIAL_FORMAT,
  parseNativeTokenPair,
} from '@kilocode/app-shared/native-auth';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { device_refresh_tokens, device_sessions, native_attested_keys } from '@kilocode/db/schema';

jest.mock('@/lib/redis', () => ({ redisClient: { get: jest.fn(async () => null) } }));
jest.mock('@/lib/user', () => ({
  ...(jest.requireActual('@/lib/user') as object),
  createOrUpdateUser: jest.fn(),
}));
jest.mock('@/lib/auth/magic-link-tokens', () => ({
  ...(jest.requireActual('@/lib/auth/magic-link-tokens') as object),
  reserveSignInCode: jest.fn(),
  commitSignInCode: jest.fn(),
  releaseSignInCode: jest.fn(),
}));
jest.mock('@/lib/auth/email-signin-eligibility', () => ({
  checkDomainSignInEligibility: jest.fn(),
}));
jest.mock('@/lib/auth/native-admission', () => ({
  ...(jest.requireActual('@/lib/auth/native-admission') as object),
  checkNativeAdmission: jest.fn(),
  validateAdmissionPayload: jest.fn(),
  verifyAdmissionAsync: jest.fn(),
}));
jest.mock('@/lib/organizations/verified-domain-membership', () => ({
  ensureVerifiedDomainOrganizationMembership: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));
jest.mock('@/lib/posthog', () => ({
  __esModule: true,
  default: jest.fn(() => ({ capture: jest.fn() })),
}));

import { POST } from './route';
import { checkDomainSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import {
  checkNativeAdmission,
  validateAdmissionPayload,
  verifyAdmissionAsync,
} from '@/lib/auth/native-admission';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { createOrUpdateUser } from '@/lib/user';
import {
  commitSignInCode,
  releaseSignInCode,
  reserveSignInCode,
} from '@/lib/auth/magic-link-tokens';
import { insertTestUser } from '@/tests/helpers/user.helper';

const nativeResourceTokensKey = 'NATIVE_RESOURCE_TOKENS_ENABLED';
const originalNativeResourceTokens = process.env[nativeResourceTokensKey];

const mockCreateOrUpdateUser = jest.mocked(createOrUpdateUser);
const mockReserveSignInCode = jest.mocked(reserveSignInCode);
const mockCommitSignInCode = jest.mocked(commitSignInCode);
const mockReleaseSignInCode = jest.mocked(releaseSignInCode);
const mockCheckDomainSignInEligibility = jest.mocked(checkDomainSignInEligibility);
const mockCheckNativeAdmission = jest.mocked(checkNativeAdmission);
const mockValidateAdmissionPayload = jest.mocked(validateAdmissionPayload);
const mockVerifyAdmissionAsync = jest.mocked(verifyAdmissionAsync);

function request(body: unknown, userAgent: string) {
  return new NextRequest('http://localhost:3000/api/auth/native/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify(body),
  });
}

function setNativeResourceTokens(enabled: boolean) {
  process.env[nativeResourceTokensKey] = String(enabled);
}

function verifyAccessToken(token: string, userId: string, sessionId: string, audience: string) {
  expect(jwt.verify(token, NEXTAUTH_SECRET, { algorithms: ['HS256'] })).toMatchObject({
    kiloUserId: userId,
    deviceSessionId: sessionId,
    aud: audience,
    tokenPurpose: 'device-access',
    credentialExchange: false,
  });
}

async function postEmailToken(userAgent: string, body: Record<string, unknown> = {}) {
  const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
  mockCreateOrUpdateUser.mockResolvedValue({ success: true, user, isNew: false });
  const response = await POST(
    request(
      {
        provider: 'email',
        email: user.google_user_email,
        code: '123456',
        supportsRefresh: true,
        credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT,
        ...body,
      },
      userAgent
    )
  );
  return { user, response };
}

afterEach(() => {
  if (originalNativeResourceTokens === undefined) {
    delete process.env[nativeResourceTokensKey];
  } else {
    process.env[nativeResourceTokensKey] = originalNativeResourceTokens;
  }
});

describe('POST /api/auth/native/token credential issuance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReserveSignInCode.mockResolvedValue('ok');
    mockCommitSignInCode.mockResolvedValue(true);
    mockReleaseSignInCode.mockResolvedValue(undefined);
    mockCheckDomainSignInEligibility.mockResolvedValue({ ok: true, existingUser: false });
    mockCheckNativeAdmission.mockReturnValue({ admission: { ok: true }, verifyAsync: false });
    mockValidateAdmissionPayload.mockReturnValue(undefined);
  });

  test('returns the legacy credential shape while resource-token issuance is disabled', async () => {
    setNativeResourceTokens(false);
    const { response } = await postEmailToken('native-token-legacy-integration');
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    const pair = parseNativeTokenPair(body);
    expect(pair).not.toBeNull();
    expect(pair?.metadata).toBeUndefined();
    expect(pair?.refreshToken).toBeDefined();
  });

  test('issues signed API and gateway credentials and persists a device session', async () => {
    setNativeResourceTokens(true);
    const userAgent = 'native-token-resource-integration';
    const { user, response } = await postEmailToken(userAgent);
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    const pair = parseNativeTokenPair(body);
    expect(pair).not.toBeNull();
    if (!pair?.refreshToken || !pair.metadata)
      throw new Error('Expected native resource credentials');

    const [session] = await db
      .select()
      .from(device_sessions)
      .where(
        and(eq(device_sessions.kilo_user_id, user.id), eq(device_sessions.user_agent, userAgent))
      );
    expect(session).toBeDefined();
    if (!session) throw new Error('Expected device session');

    const refreshTokens = await db
      .select()
      .from(device_refresh_tokens)
      .where(eq(device_refresh_tokens.device_session_id, session.id));
    expect(refreshTokens).toHaveLength(1);
    expect(pair.metadata.credentialFormat).toBe(API_GATEWAY_CREDENTIAL_FORMAT);
    expect(pair.token).not.toBe(pair.metadata.gatewayToken);
    verifyAccessToken(pair.token, user.id, session.id, KILO_API_AUDIENCE);
    verifyAccessToken(pair.metadata.gatewayToken, user.id, session.id, KILO_GATEWAY_AUDIENCE);
  });

  test('atomically persists an asynchronously verified iOS key with its credential session', async () => {
    setNativeResourceTokens(true);
    const keyId = `native-token-attested-key-${crypto.randomUUID()}`;
    const publicKey = Buffer.from('native token integration key').toString('base64');
    mockCheckNativeAdmission.mockReturnValue({ admission: { ok: true }, verifyAsync: true });
    mockValidateAdmissionPayload.mockReturnValue({
      platform: 'ios',
      kind: 'attestation',
      challenge: 'native-token-integration-challenge',
      payload: 'native-token-integration-payload',
      keyId,
    });
    mockVerifyAdmissionAsync.mockResolvedValue({ ok: true, platform: 'ios', keyId, publicKey });

    const { user, response } = await postEmailToken('native-token-attested-integration', {
      admission: {
        platform: 'ios',
        kind: 'attestation',
        challenge: 'native-token-integration-challenge',
        payload: 'native-token-integration-payload',
        keyId,
      },
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    const pair = parseNativeTokenPair(body);
    expect(pair).not.toBeNull();
    if (!pair?.refreshToken || !pair.metadata)
      throw new Error('Expected attested native credentials');

    const [key] = await db
      .select()
      .from(native_attested_keys)
      .where(eq(native_attested_keys.key_id, keyId));
    expect(key).toMatchObject({ kilo_user_id: user.id, platform: 'ios', public_key: publicKey });

    const [session] = await db
      .select()
      .from(device_sessions)
      .where(eq(device_sessions.kilo_user_id, user.id));
    expect(session).toBeDefined();
    if (!session) throw new Error('Expected attested device session');
    const refreshTokens = await db
      .select()
      .from(device_refresh_tokens)
      .where(eq(device_refresh_tokens.device_session_id, session.id));
    expect(refreshTokens).toHaveLength(1);
    verifyAccessToken(pair.token, user.id, session.id, KILO_API_AUDIENCE);
    verifyAccessToken(pair.metadata.gatewayToken, user.id, session.id, KILO_GATEWAY_AUDIENCE);
  });
});
