import { afterEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import {
  API_GATEWAY_CREDENTIAL_FORMAT,
  parseNativeTokenPair,
} from '@kilocode/app-shared/native-auth';
import { kilocode_users } from '@kilocode/db/schema';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { approveDeviceAuthRequest, createDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { POST } from './route';
import { GET as legacyPoll } from '../codes/[code]/route';
import { POST as refresh } from '../../auth/native/refresh/route';

const nativeKey = 'NATIVE_RESOURCE_TOKENS_ENABLED';
const sharedKey = 'SHARED_RESOURCE_TOKENS_ENABLED';
const previousNative = process.env[nativeKey];
const previousShared = process.env[sharedKey];

afterEach(() => {
  if (previousNative === undefined) delete process.env[nativeKey];
  else process.env[nativeKey] = previousNative;
  if (previousShared === undefined) delete process.env[sharedKey];
  else process.env[sharedKey] = previousShared;
});

describe.each([undefined, 'false'])('device polling: native=%s, shared=true', nativeFlag => {
  test.each([
    { supportsRefresh: true, credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT },
    { supportsRefresh: true },
    {},
  ])('preserves legacy credentials and null pepper for %j', async negotiation => {
    process.env[sharedKey] = 'true';
    if (nativeFlag === undefined) delete process.env[nativeKey];
    else process.env[nativeKey] = nativeFlag;
    const user = await insertTestUser({ api_token_pepper: null });
    const code = await createDeviceAuthRequest({});
    await approveDeviceAuthRequest(code.code, user.id);
    const request = new NextRequest('http://localhost/api/device-auth/token', {
      method: 'POST',
      body: JSON.stringify({ deviceCode: code.deviceCode, ...negotiation }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const raw: unknown = await response.json();
    expect(raw).toMatchObject({ status: 'approved', userId: user.id });
    expect(raw).not.toHaveProperty('metadata');
    const pair = parseNativeTokenPair(raw);
    if (!pair) {
      throw new Error('Expected a legacy device pair');
    }
    const claims = jwt.verify(pair.token, NEXTAUTH_SECRET) as jwt.JwtPayload;
    expect(claims).toMatchObject({ kiloUserId: user.id, apiTokenPepper: null });
    expect(claims).not.toHaveProperty('aud');
    expect(claims.exp! - claims.iat!).toBe(
      'supportsRefresh' in negotiation ? 3600 : 5 * 365 * 24 * 3600
    );
    if (pair.refreshToken) {
      const renewed = await refresh(
        new NextRequest('http://localhost/api/auth/native/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken: pair.refreshToken, ...negotiation }),
        })
      );
      expect(renewed.status).toBe(200);
      const nextRaw: unknown = await renewed.json();
      expect(nextRaw).not.toHaveProperty('metadata');
      const next = parseNativeTokenPair(nextRaw);
      if (!next) {
        throw new Error('Expected a legacy refresh pair');
      }
      expect(next.refreshToken).not.toBe(pair.refreshToken);
      expect(next.expiresIn).toBe(3600);
      expect(jwt.verify(next.token, NEXTAUTH_SECRET)).not.toHaveProperty('aud');
    }
    const oldCode = await createDeviceAuthRequest({});
    await approveDeviceAuthRequest(oldCode.code, user.id);
    const oldResponse = await legacyPoll(
      new Request('http://localhost/api/device-auth/codes/legacy'),
      {
        params: Promise.resolve({ code: oldCode.code }),
      }
    );
    expect(oldResponse.status).toBe(200);
    const oldRaw: unknown = await oldResponse.json();
    expect(oldRaw).not.toHaveProperty('metadata');
    expect(oldRaw).not.toHaveProperty('refreshToken');
    const oldPair = parseNativeTokenPair(oldRaw);
    if (!oldPair) {
      throw new Error('Expected an old CLI-compatible response');
    }
    expect(jwt.verify(oldPair.token, NEXTAUTH_SECRET)).toMatchObject({
      kiloUserId: user.id,
      apiTokenPepper: null,
      deviceAuthRequestCode: oldCode.code,
    });
    expect(jwt.verify(oldPair.token, NEXTAUTH_SECRET)).not.toHaveProperty('aud');
    const [storedUser] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(storedUser?.api_token_pepper).toBeNull();
  });
});
