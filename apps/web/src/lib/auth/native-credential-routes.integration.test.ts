import { afterEach, describe, expect, test } from '@jest/globals';
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
import {
  device_auth_requests,
  device_refresh_tokens,
  device_sessions,
  native_attested_keys,
} from '@kilocode/db/schema';

import { POST as exchange } from '@/app/api/auth/native/exchange/route';
import { POST as refresh } from '@/app/api/auth/native/refresh/route';
import { POST as deviceToken } from '@/app/api/device-auth/token/route';
import { createDeviceSessionWithAttestedKey } from '@/lib/auth/device-sessions';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { createDeviceAuthRequest, approveDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { db } from '@/lib/drizzle';
import { generateApiToken } from '@/lib/tokens';
import { insertTestUser } from '@/tests/helpers/user.helper';

const nativeResourceTokensKey = 'NATIVE_RESOURCE_TOKENS_ENABLED';
const originalNativeResourceTokens = process.env[nativeResourceTokensKey];

function setNativeResourceTokens(enabled: boolean) {
  process.env[nativeResourceTokensKey] = String(enabled);
}

function request(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function verifyDeviceAccessToken(
  token: string,
  userId: string,
  sessionId: string,
  audience: string
) {
  const payload = jwt.verify(token, NEXTAUTH_SECRET, { algorithms: ['HS256'] });
  expect(payload).toMatchObject({
    kiloUserId: userId,
    aud: audience,
    tokenPurpose: 'device-access',
    credentialExchange: false,
    deviceSessionId: sessionId,
  });
}

async function refreshRows(sessionId: string) {
  return db
    .select()
    .from(device_refresh_tokens)
    .where(eq(device_refresh_tokens.device_session_id, sessionId));
}

afterEach(() => {
  if (originalNativeResourceTokens === undefined) {
    delete process.env[nativeResourceTokensKey];
  } else {
    process.env[nativeResourceTokensKey] = originalNativeResourceTokens;
  }
});

describe('native credential routes with PostgreSQL-backed sessions', () => {
  test('exchanges an eligible five-year legacy bearer and rotates its native credential bundle', async () => {
    setNativeResourceTokens(true);
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const legacyBearer = generateApiToken(user);

    const exchangeResponse = await exchange(
      request(
        'http://localhost:3000/api/auth/native/exchange',
        { credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT },
        { Authorization: `Bearer ${legacyBearer}`, 'User-Agent': 'native-integration-test' }
      )
    );
    const exchangeBody: unknown = await exchangeResponse.json();

    expect(exchangeResponse.status).toBe(200);
    expect(exchangeResponse.headers.get('cache-control')).toBe('no-store');
    const pair = parseNativeTokenPair(exchangeBody);
    expect(pair).not.toBeNull();
    expect(pair).toMatchObject({
      expiresIn: 3600,
      metadata: { credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT },
    });
    if (!pair?.refreshToken || !pair.metadata)
      throw new Error('Expected a native credential bundle');

    const [session] = await db
      .select()
      .from(device_sessions)
      .where(
        and(
          eq(device_sessions.kilo_user_id, user.id),
          eq(device_sessions.user_agent, 'native-integration-test')
        )
      );
    expect(session).toBeDefined();
    if (!session) throw new Error('Expected device session');
    expect(await refreshRows(session.id)).toHaveLength(1);
    verifyDeviceAccessToken(pair.token, user.id, session.id, KILO_API_AUDIENCE);
    verifyDeviceAccessToken(pair.metadata.gatewayToken, user.id, session.id, KILO_GATEWAY_AUDIENCE);

    const refreshResponse = await refresh(
      request('http://localhost:3000/api/auth/native/refresh', {
        refreshToken: pair.refreshToken,
        credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT,
      })
    );
    const refreshBody: unknown = await refreshResponse.json();

    expect(refreshResponse.status).toBe(200);
    const rotated = parseNativeTokenPair(refreshBody);
    expect(rotated).not.toBeNull();
    if (!rotated?.refreshToken || !rotated.metadata)
      throw new Error('Expected rotated native credential bundle');
    expect(rotated.refreshToken).not.toBe(pair.refreshToken);
    verifyDeviceAccessToken(rotated.token, user.id, session.id, KILO_API_AUDIENCE);
    verifyDeviceAccessToken(
      rotated.metadata.gatewayToken,
      user.id,
      session.id,
      KILO_GATEWAY_AUDIENCE
    );

    const storedTokens = await refreshRows(session.id);
    expect(storedTokens).toHaveLength(2);
    expect(storedTokens.filter(token => token.consumed_at !== null)).toHaveLength(1);
    expect(storedTokens.filter(token => token.consumed_at === null)).toHaveLength(1);
  });

  test('rolls a requested format back to the legacy credential response while the flag is off', async () => {
    setNativeResourceTokens(false);
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });

    const response = await exchange(
      request(
        'http://localhost:3000/api/auth/native/exchange',
        { credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT },
        { Authorization: `Bearer ${generateApiToken(user)}` }
      )
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    const pair = parseNativeTokenPair(body);
    expect(pair).not.toBeNull();
    expect(pair?.metadata).toBeUndefined();
    if (!pair?.refreshToken) throw new Error('Expected legacy refresh token');
    const payload = jwt.verify(pair.token, NEXTAUTH_SECRET, { algorithms: ['HS256'] });
    expect(payload).toMatchObject({ kiloUserId: user.id });
  });

  test('redeems an approved device code into a complete native credential envelope', async () => {
    setNativeResourceTokens(true);
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const deviceAuth = await createDeviceAuthRequest({ userAgent: 'device-code-integration-test' });
    await approveDeviceAuthRequest(deviceAuth.code, user.id);

    const response = await deviceToken(
      request('http://localhost:3000/api/device-auth/token', {
        deviceCode: deviceAuth.deviceCode,
        supportsRefresh: true,
        credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT,
      })
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    const pair = parseNativeTokenPair(body);
    expect(pair).not.toBeNull();
    if (!pair?.refreshToken || !pair.metadata)
      throw new Error('Expected device-code credential bundle');

    const [deviceAuthRow] = await db
      .select({ id: device_auth_requests.id })
      .from(device_auth_requests)
      .where(eq(device_auth_requests.code, deviceAuth.code));
    expect(deviceAuthRow).toBeDefined();
    if (!deviceAuthRow) throw new Error('Expected consumed device authorization request');

    const [session] = await db
      .select()
      .from(device_sessions)
      .where(
        and(
          eq(device_sessions.kilo_user_id, user.id),
          eq(device_sessions.user_agent, 'device-code-integration-test')
        )
      );
    expect(session).toBeDefined();
    if (!session) throw new Error('Expected device-code session');
    expect(session.kilo_user_id).toBe(user.id);
    expect(session.device_auth_request_id).toBe(deviceAuthRow.id);
    expect(await refreshRows(session.id)).toHaveLength(1);
    verifyDeviceAccessToken(pair.token, user.id, session.id, KILO_API_AUDIENCE);
    verifyDeviceAccessToken(pair.metadata.gatewayToken, user.id, session.id, KILO_GATEWAY_AUDIENCE);
  });

  test('persists an attested iOS key atomically with a native device session', async () => {
    setNativeResourceTokens(true);
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const keyId = `native-integration-key-${crypto.randomUUID()}`;
    const credentials = await createDeviceSessionWithAttestedKey({
      userId: user.id,
      user,
      credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT,
      verification: {
        ok: true,
        platform: 'ios',
        keyId,
        publicKey: Buffer.from('native integration fixture key').toString('base64'),
      },
    });

    expect(
      await db.query.native_attested_keys.findFirst({
        where: eq(native_attested_keys.key_id, keyId),
      })
    ).toMatchObject({ kilo_user_id: user.id, platform: 'ios' });
    expect(await refreshRows(credentials.sessionId)).toHaveLength(1);
    verifyDeviceAccessToken(credentials.token, user.id, credentials.sessionId, KILO_API_AUDIENCE);
    if (!credentials.metadata) throw new Error('Expected attested native credential bundle');
    verifyDeviceAccessToken(
      credentials.metadata.gatewayToken,
      user.id,
      credentials.sessionId,
      KILO_GATEWAY_AUDIENCE
    );
  });
});
