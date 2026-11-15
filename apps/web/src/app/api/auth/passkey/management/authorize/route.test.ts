import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/user');
jest.mock('@/lib/auth/email-signin-eligibility');
jest.mock('@/lib/auth/native-admission', () => ({
  ...(jest.requireActual('@/lib/auth/native-admission') as object),
  verifyAdmissionAsync: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/auth/magic-link-tokens', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/auth/magic-link-tokens') as object),
  commitSignInCode: jest.fn(),
}));

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { findUserBySignInCodeEmail } from '@/lib/user';
import { checkDomainSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import { verifyAdmissionAsync } from '@/lib/auth/native-admission';
import {
  commitSignInCode,
  createSignInCode,
  releaseSignInCode,
  reserveSignInCode,
} from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import type * as MagicLinkTokensModule from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import { createSignInTicket } from '@/lib/auth/passkey';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions, passkey_management_authorizations, type User } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { validatePasskeyManagementAuthorization } from '@/lib/auth/passkey-management';
import { POST } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockFindUserBySignInCodeEmail = jest.mocked(findUserBySignInCodeEmail);
const mockCheckDomainSignInEligibility = jest.mocked(checkDomainSignInEligibility);
const mockVerifyAdmissionAsync = jest.mocked(verifyAdmissionAsync);
const mockCommitSignInCode = jest.mocked(commitSignInCode);

const realCommitSignInCode = jest.requireActual<typeof MagicLinkTokensModule>(
  '@kilocode/web-shared/lib/auth/magic-link-tokens'
).commitSignInCode;

const admission = {
  platform: 'android',
  kind: 'assertion',
  challenge: 'challenge',
  payload: 'integrity-token',
};

const AUTHORIZE_URL = 'http://localhost:3000/api/auth/passkey/management/authorize';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(AUTHORIZE_URL, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer session-token' },
  });
}

async function insertNativeSession(kiloUserId: string): Promise<string> {
  const [row] = await db
    .insert(device_sessions)
    .values({ kilo_user_id: kiloUserId })
    .returning({ id: device_sessions.id });
  return row!.id;
}

/**
 * A session the app minted through the browser device-auth flow. That flow
 * records the request in `device_auth_request_id`; the column says how the
 * session was signed in, not which client owns it.
 */
async function insertBrowserSignedInSession(kiloUserId: string): Promise<string> {
  const [row] = await db
    .insert(device_sessions)
    .values({ kilo_user_id: kiloUserId, device_auth_request_id: randomUUID() })
    .returning({ id: device_sessions.id });
  return row!.id;
}

function authenticate(
  user: User,
  deviceSessionId: string | undefined,
  credential = 'human_bearer'
) {
  mockGetUserFromAuth.mockResolvedValue({
    user,
    authFailedResponse: null,
    credential: credential as never,
    deviceSessionId,
  } as never);
}

async function grantCount(kiloUserId: string): Promise<number> {
  const rows = await db
    .select({ id: passkey_management_authorizations.id })
    .from(passkey_management_authorizations)
    .where(eq(passkey_management_authorizations.kilo_user_id, kiloUserId));
  return rows.length;
}

describe('POST /api/auth/passkey/management/authorize', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckDomainSignInEligibility.mockResolvedValue({ ok: true, existingUser: true });
    mockVerifyAdmissionAsync.mockResolvedValue({ ok: true } as never);
    mockCommitSignInCode.mockImplementation(realCommitSignInCode);
  });

  it('issues a grant for a valid email code and spends the code', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    mockFindUserBySignInCodeEmail.mockResolvedValue(user);
    const { code, challengeId } = await createSignInCode(user.google_user_email);

    const response = await POST(
      createRequest({
        proof: 'email',
        operation: 'enroll',
        email: user.google_user_email,
        code,
        challengeId,
        admission,
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      authorization: string;
      operation: string;
      expiresIn: number;
    };
    expect(body.operation).toBe('enroll');
    expect(body.expiresIn).toBeGreaterThan(0);
    await expect(
      validatePasskeyManagementAuthorization({
        token: body.authorization,
        userId: user.id,
        deviceSessionId,
        operation: 'enroll',
      })
    ).resolves.toBe(true);

    // The code is settled, so the same code cannot mint a second grant.
    const replay = await POST(
      createRequest({
        proof: 'email',
        operation: 'enroll',
        email: user.google_user_email,
        code,
        challengeId,
        admission,
      })
    );
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({ error: 'INVALID_CODE' });
    await expect(grantCount(user.id)).resolves.toBe(1);
  });

  it('refuses an SSO-enforced account with the sign-in eligibility error', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    mockFindUserBySignInCodeEmail.mockResolvedValue(user);
    mockCheckDomainSignInEligibility.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: 'SSO_ERROR',
      ssoOrganizationId: 'org-sso-1',
    });
    const { code, challengeId } = await createSignInCode(user.google_user_email);

    const response = await POST(
      createRequest({
        proof: 'email',
        operation: 'enroll',
        email: user.google_user_email,
        code,
        challengeId,
        admission,
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'SSO_ERROR',
      ssoOrganizationId: 'org-sso-1',
    });
    // The code was never reserved, so it is still usable if the policy changes.
    await expect(grantCount(user.id)).resolves.toBe(0);
  });

  it('does not leave a usable grant when the code cannot be settled', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    mockFindUserBySignInCodeEmail.mockResolvedValue(user);
    const { code, challengeId } = await createSignInCode(user.google_user_email);
    mockCommitSignInCode.mockResolvedValue(false);

    const response = await POST(
      createRequest({
        proof: 'email',
        operation: 'remove',
        email: user.google_user_email,
        code,
        challengeId,
        admission,
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_CODE' });
    await expect(grantCount(user.id)).resolves.toBe(0);
  });

  it('releases the reservation and drops the grant when settlement throws', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    mockFindUserBySignInCodeEmail.mockResolvedValue(user);
    const { code, challengeId } = await createSignInCode(user.google_user_email);
    mockCommitSignInCode.mockRejectedValue(new Error('drizzle down'));

    await expect(
      POST(
        createRequest({
          proof: 'email',
          operation: 'remove',
          email: user.google_user_email,
          code,
          challengeId,
          admission,
        })
      )
    ).rejects.toThrow('drizzle down');

    await expect(grantCount(user.id)).resolves.toBe(0);
    // The reservation was released, so the code stays usable and cost the user
    // no attempt.
    await expect(reserveSignInCode(user.google_user_email, code, challengeId)).resolves.toBe('ok');
    await releaseSignInCode(user.google_user_email, code, challengeId);
  });

  it('refuses an ordinary API key bearer', async () => {
    const user = await insertTestUser();
    authenticate(user, undefined);

    const response = await POST(
      createRequest({
        proof: 'email',
        operation: 'remove',
        email: user.google_user_email,
        code: '123456',
        admission,
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED',
    });
    await expect(grantCount(user.id)).resolves.toBe(0);
  });

  it('refuses a cookie session bearer', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId, 'session');

    const response = await POST(
      createRequest({
        proof: 'passkey',
        operation: 'remove',
        ticket: 'a'.repeat(64),
        admission,
      })
    );

    expect(response.status).toBe(403);
    await expect(grantCount(user.id)).resolves.toBe(0);
  });

  it('issues a grant to a session the app signed in through the browser', async () => {
    const user = await insertTestUser();
    // The app's SSO and OAuth sign-ins run in the browser, so their sessions
    // carry `device_auth_request_id`. They are the app's own sessions and must
    // be able to manage passkeys.
    const deviceSessionId = await insertBrowserSignedInSession(user.id);
    authenticate(user, deviceSessionId);
    const ticket = await createSignInTicket(user.id);

    const response = await POST(
      createRequest({ proof: 'passkey', operation: 'enroll', ticket, admission })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorization: string };
    await expect(
      validatePasskeyManagementAuthorization({
        token: body.authorization,
        userId: user.id,
        deviceSessionId,
        operation: 'enroll',
      })
    ).resolves.toBe(true);
  });

  it('refuses a session revoked after authentication', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    await db
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(device_sessions.id, deviceSessionId));

    const response = await POST(
      createRequest({
        proof: 'email',
        operation: 'enroll',
        email: user.google_user_email,
        code: '123456',
        admission,
      })
    );

    expect(response.status).toBe(403);
    await expect(grantCount(user.id)).resolves.toBe(0);
  });

  it('refuses a code that belongs to another account without spending it', async () => {
    const user = await insertTestUser();
    const other = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    mockFindUserBySignInCodeEmail.mockResolvedValue(other);
    const { code, challengeId } = await createSignInCode(other.google_user_email);

    const response = await POST(
      createRequest({
        proof: 'email',
        operation: 'remove',
        email: other.google_user_email,
        code,
        challengeId,
        admission,
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_CODE' });
    await expect(grantCount(user.id)).resolves.toBe(0);
    // The other account's code is untouched and still usable.
    await expect(reserveSignInCode(other.google_user_email, code, challengeId)).resolves.toBe('ok');
    await releaseSignInCode(other.google_user_email, code, challengeId);
  });

  it('refuses a wrong code without minting', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    mockFindUserBySignInCodeEmail.mockResolvedValue(user);
    const { code, challengeId } = await createSignInCode(user.google_user_email);
    const wrongCode = code === '000000' ? '000001' : '000000';

    const response = await POST(
      createRequest({
        proof: 'email',
        operation: 'enroll',
        email: user.google_user_email,
        code: wrongCode,
        challengeId,
        admission,
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_CODE' });
    await expect(grantCount(user.id)).resolves.toBe(0);
  });

  it('issues a grant for a passkey assertion ticket and redeems it once', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    const ticket = await createSignInTicket(user.id);

    const response = await POST(
      createRequest({ proof: 'passkey', operation: 'remove', ticket, admission })
    );

    expect(response.status).toBe(200);
    const replay = await POST(
      createRequest({ proof: 'passkey', operation: 'remove', ticket, admission })
    );
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({ error: 'INVALID_TICKET' });
  });

  it("refuses another account's passkey ticket", async () => {
    const user = await insertTestUser();
    const other = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    const ticket = await createSignInTicket(other.id);

    const response = await POST(
      createRequest({ proof: 'passkey', operation: 'remove', ticket, admission })
    );

    expect(response.status).toBe(401);
    await expect(grantCount(user.id)).resolves.toBe(0);
    await expect(grantCount(other.id)).resolves.toBe(0);
  });

  it('requires a device proof', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);

    const response = await POST(
      createRequest({
        proof: 'email',
        operation: 'enroll',
        email: user.google_user_email,
        code: '123456',
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'ADMISSION_REQUIRED' });
    await expect(grantCount(user.id)).resolves.toBe(0);
  });

  it('refuses a refused device proof', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    mockVerifyAdmissionAsync.mockResolvedValue({
      ok: false,
      errorCode: 'INVALID_ASSERTION',
    } as never);

    const response = await POST(
      createRequest({
        proof: 'passkey',
        operation: 'remove',
        ticket: 'a'.repeat(64),
        admission,
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_ASSERTION' });
  });

  it('refuses a body that names no known proof', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);

    const response = await POST(createRequest({ proof: 'otp', operation: 'enroll' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
  });
});
