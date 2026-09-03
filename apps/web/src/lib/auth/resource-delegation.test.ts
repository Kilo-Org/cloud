import { afterEach, describe, expect, test } from '@jest/globals';
import { device_sessions, kilocode_users } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { buildModernKiloTokenPayload } from '@kilocode/worker-utils/kilo-token-policy';

const shared = { enabled: true };
jest.mock('@/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'resource-delegation-test-secret',
  isSharedResourceTokenIssuanceEnabled: () => shared.enabled,
}));
jest.mock('@/lib/user/server', () => ({
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));

import {
  createControlTokenForRequest,
  createDelegatedResourceToken,
  getResourceDelegationAuthority,
} from './resource-delegation';
import { db } from '@/lib/drizzle';
import { getUserFromSessionForCredentialIssuance } from '@/lib/user/server';
import { insertTestUser } from '@/tests/helpers/user.helper';

const secret = 'resource-delegation-test-secret';
const cleanups: string[] = [];

afterEach(async () => {
  if (cleanups.length) {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, cleanups));
    cleanups.length = 0;
  }
  shared.enabled = true;
  jest.clearAllMocks();
});

async function user() {
  const row = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
  cleanups.push(row.id);
  return row;
}

function bearer(token: string) {
  return new Headers({ authorization: `Bearer ${token}` });
}

function modernToken(
  user: { id: string; api_token_pepper: string | null },
  options?: {
    purpose?: 'human-api' | 'device-access';
    exchange?: boolean;
    deviceSessionId?: string;
  }
) {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    userId: user.id,
    pepper: user.api_token_pepper,
    env: process.env.NODE_ENV,
    audience: 'kilo-api',
    issuedAt: now,
    expiresAt: now + 1800,
    extra: options?.deviceSessionId ? { deviceSessionId: options.deviceSessionId } : undefined,
  };
  const payload =
    options?.purpose === 'device-access'
      ? buildModernKiloTokenPayload({
          ...base,
          tokenPurpose: 'device-access',
          credentialExchange: false,
        })
      : buildModernKiloTokenPayload({
          ...base,
          tokenPurpose: 'human-api',
          credentialExchange: options?.exchange ?? true,
        });
  return jwt.sign(payload, secret, { algorithm: 'HS256' });
}

describe('resource delegation authority', () => {
  test('accepts an exchangeable modern human API credential and preserves its provenance', async () => {
    const current = await user();
    const authority = await getResourceDelegationAuthority(current, {
      headers: bearer(modernToken(current)),
    });

    expect(authority).toMatchObject({
      credentialKind: 'human-api',
      isModern: true,
      runtimeAdmission: { source: 'user', authorizationUserId: current.id },
    });
  });

  test('requires an active owned device session for a modern device credential', async () => {
    const current = await user();
    const [session] = await db
      .insert(device_sessions)
      .values({ kilo_user_id: current.id, user_agent: 'resource-delegation-test' })
      .returning({ id: device_sessions.id });

    const authority = await getResourceDelegationAuthority(current, {
      headers: bearer(
        modernToken(current, {
          purpose: 'device-access',
          exchange: false,
          deviceSessionId: session.id,
        })
      ),
    });
    expect(authority.credentialKind).toBe('device-access');
  });

  test('rejects restricted modern principals rather than projecting away their source claim', async () => {
    const current = await user();
    const claims = jwt.decode(modernToken(current));
    if (!claims || typeof claims === 'string') throw new Error('Expected JWT claims');
    const token = jwt.sign({ ...claims, tokenSource: 'cloud-agent' }, secret, {
      algorithm: 'HS256',
    });
    await expect(
      getResourceDelegationAuthority(current, { headers: bearer(token) })
    ).rejects.toThrow('Unauthorized resource delegation request');
  });

  test('does not fall back to ambient cookies for malformed supplied authorization', async () => {
    const current = await user();
    jest.mocked(getUserFromSessionForCredentialIssuance).mockResolvedValue({
      user: current,
      authFailedResponse: null,
    });
    await expect(
      getResourceDelegationAuthority(current, {
        headers: new Headers({ authorization: 'Basic bad' }),
      })
    ).rejects.toThrow('Unauthorized resource delegation request');
  });

  test('mints a bounded single-audience control token from a verified authority', async () => {
    const current = await user();
    const result = await createControlTokenForRequest(current, 'gastown', {
      headers: bearer(modernToken(current)),
      expiresIn: 7200,
    });
    const claims = jwt.verify(result.token, secret) as jwt.JwtPayload;
    expect(claims).toMatchObject({
      aud: 'gastown',
      tokenPurpose: 'human-api',
      credentialExchange: false,
      runtimeAdmission: { source: 'user', authorizationUserId: current.id },
    });
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(3600);
  });

  test('keeps a legitimate legacy session request on the legacy contract when disabled', async () => {
    shared.enabled = false;
    const current = await user();
    jest.mocked(getUserFromSessionForCredentialIssuance).mockResolvedValue({
      user: current,
      authFailedResponse: null,
    });
    const result = await createControlTokenForRequest(current, 'gastown', {
      headers: new Headers(),
      legacyExpiresIn: 60,
    });
    const claims = jwt.verify(result.token, secret) as jwt.JwtPayload;
    expect(claims.aud).toBeUndefined();
    expect(claims.exp! - claims.iat!).toBe(60);
  });

  test('returns migration unavailable for a verified modern user principal when disabled', async () => {
    shared.enabled = false;
    const current = await user();
    await expect(
      createControlTokenForRequest(current, 'wasteland', { headers: bearer(modernToken(current)) })
    ).rejects.toMatchObject({ status: 503, delegationCode: 'MIGRATION_UNAVAILABLE' });
  });

  test('mints a non-exchangeable delegated token for exactly the selected audience', async () => {
    const current = await user();
    const result = await createDelegatedResourceToken(current, 'gateway', {
      headers: bearer(modernToken(current)),
    });
    const claims = jwt.verify(result.token, secret) as jwt.JwtPayload;
    expect(claims).toMatchObject({
      aud: 'kilo-gateway',
      tokenPurpose: 'delegated-workload',
      credentialExchange: false,
    });
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(15 * 60);
  });

  test('caps delegated tokens to the parent credential expiry', async () => {
    const current = await user();
    const now = Math.floor(Date.now() / 1000);
    const claims = buildModernKiloTokenPayload({
      userId: current.id,
      pepper: current.api_token_pepper,
      env: process.env.NODE_ENV,
      audience: 'kilo-api',
      issuedAt: now - 1,
      expiresAt: now + 30,
      tokenPurpose: 'human-api',
      credentialExchange: true,
    });
    const parent = jwt.sign(claims, secret, { algorithm: 'HS256' });
    const result = await createDelegatedResourceToken(current, 'api', { headers: bearer(parent) });
    const delegated = jwt.verify(result.token, secret) as jwt.JwtPayload;
    expect(delegated.exp! - delegated.iat!).toBeLessThanOrEqual(30);
  });
});
