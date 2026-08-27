jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth/apple-jwks', () => ({
  ...jest.requireActual('@/lib/auth/apple-jwks'),
  verifyAppleJwtWithJwks: jest.fn(),
}));
jest.mock('@/lib/web-session-revocation', () => {
  const actual = jest.requireActual('@/lib/web-session-revocation');
  return { ...actual, revokeWebSessions: jest.fn(actual.revokeWebSessions) };
});

import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import type jwt from 'jsonwebtoken';
import {
  device_refresh_tokens,
  device_sessions,
  kilocode_users,
  user_auth_provider,
} from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { verifyAppleJwtWithJwks } from '@/lib/auth/apple-jwks';
import { revokeWebSessions } from '@/lib/web-session-revocation';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { POST } from './route';

const mockVerifyAppleJwtWithJwks = jest.mocked(verifyAppleJwtWithJwks);
const mockRevokeWebSessions = jest.mocked(revokeWebSessions);
const mockCaptureException = jest.mocked(captureException);

type AppleEventType = 'consent-revoked' | 'account-delete';

const SUB = 'apple-sub-001';

// The app-wide `jsonwebtoken` augmentation (types/next-auth.d.ts) requires
// kiloUserId/version on JwtPayload; Apple's payload has neither, so cast fixtures.
const applePayload = (fields: Record<string, unknown>) => fields as unknown as jwt.JwtPayload;

function applePost() {
  const formData = new FormData();
  formData.set('payload', 'fake-apple-jwt');
  return new NextRequest('http://localhost/api/auth/apple-notifications', {
    method: 'POST',
    body: formData,
  });
}

async function insertAppleProvider(userId: string, sub: string) {
  await db.insert(user_auth_provider).values({
    kilo_user_id: userId,
    provider: 'apple',
    provider_account_id: sub,
    email: 'apple-user@example.com',
    avatar_url: 'https://example.com/apple-avatar.png',
  });
}

async function providerRow(sub: string) {
  const rows = await db
    .select()
    .from(user_auth_provider)
    .where(
      and(eq(user_auth_provider.provider, 'apple'), eq(user_auth_provider.provider_account_id, sub))
    );
  return rows[0];
}

async function userWebPepper(userId: string) {
  const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, userId));
  return row?.web_session_pepper ?? null;
}

async function sessionRow(sessionId: string) {
  const [row] = await db.select().from(device_sessions).where(eq(device_sessions.id, sessionId));
  return row;
}

async function refreshTokenRow(tokenHash: string) {
  const [row] = await db
    .select()
    .from(device_refresh_tokens)
    .where(eq(device_refresh_tokens.token_hash, tokenHash));
  return row;
}

describe('POST /api/auth/apple-notifications', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.clearAllMocks();
  });

  it.each(['consent-revoked', 'account-delete'] as AppleEventType[])(
    'revokes provider, web, and device sessions for a %s event',
    async type => {
      const user = await insertTestUser({ web_session_pepper: 'old-web-pepper' });
      const other = await insertTestUser();
      await insertAppleProvider(user.id, SUB);

      const [session] = await db
        .insert(device_sessions)
        .values({ kilo_user_id: user.id, user_agent: 'AppleRevokeTest/1.0' })
        .returning({ id: device_sessions.id });
      const [otherSession] = await db
        .insert(device_sessions)
        .values({ kilo_user_id: other.id, user_agent: 'AppleRevokeTest/1.0' })
        .returning({ id: device_sessions.id });

      const tokenHash = 'apple-revoke-token-hash';
      await db.insert(device_refresh_tokens).values({
        token_hash: tokenHash,
        device_session_id: session.id,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const consumedTokenHash = 'apple-revoke-consumed-token-hash';
      await db.insert(device_refresh_tokens).values({
        token_hash: consumedTokenHash,
        device_session_id: session.id,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        consumed_at: new Date().toISOString(),
      });

      mockVerifyAppleJwtWithJwks.mockResolvedValue(
        applePayload({ events: JSON.stringify({ type, sub: SUB, event_time: 1_700_000_000 }) })
      );

      const response = await POST(applePost());

      expect(response.status).toBe(200);

      expect(await providerRow(SUB)).toBeUndefined();

      const webPepper = await userWebPepper(user.id);
      expect(webPepper).toEqual(expect.any(String));
      expect(webPepper).not.toBe('old-web-pepper');

      const revoked = await sessionRow(session.id);
      expect(revoked?.revoked_at).not.toBeNull();
      expect(revoked?.revoked_reason).toBe('apple_provider_revoked');

      expect(await refreshTokenRow(tokenHash)).toBeUndefined();
      expect(await refreshTokenRow(consumedTokenHash)).toBeDefined();

      const untouched = await sessionRow(otherSession.id);
      expect(untouched?.revoked_at).toBeNull();
    }
  );

  it('treats an unknown sub as a no-op', async () => {
    const user = await insertTestUser();
    await insertAppleProvider(user.id, 'apple-sub-other');

    mockVerifyAppleJwtWithJwks.mockResolvedValue(
      applePayload({
        events: JSON.stringify({ type: 'consent-revoked', sub: SUB, event_time: 1_700_000_000 }),
      })
    );

    const response = await POST(applePost());

    expect(response.status).toBe(200);
    expect(await providerRow('apple-sub-other')).toBeDefined();
    expect(mockRevokeWebSessions).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('rolls back the provider delete and session revocation when a later statement throws', async () => {
    const user = await insertTestUser({ web_session_pepper: 'old-web-pepper' });
    await insertAppleProvider(user.id, SUB);

    const [session] = await db
      .insert(device_sessions)
      .values({ kilo_user_id: user.id, user_agent: 'AppleRollbackTest/1.0' })
      .returning({ id: device_sessions.id });

    mockVerifyAppleJwtWithJwks.mockResolvedValue(
      applePayload({
        events: JSON.stringify({ type: 'account-delete', sub: SUB, event_time: 1_700_000_000 }),
      })
    );
    mockRevokeWebSessions.mockRejectedValueOnce(new Error('boom'));

    const response = await POST(applePost());

    expect(response.status).toBe(500);
    expect(mockCaptureException).toHaveBeenCalled();

    expect(await providerRow(SUB)).toBeDefined();
    expect(await userWebPepper(user.id)).toBe('old-web-pepper');
    expect((await sessionRow(session.id))?.revoked_at).toBeNull();
  });
});
