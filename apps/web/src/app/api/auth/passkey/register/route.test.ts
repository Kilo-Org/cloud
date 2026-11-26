import { NextRequest, NextResponse } from 'next/server';

jest.mock('@kilocode/web-shared/lib/user/server');
// Keep the real PasskeyVerificationError (the route uses `instanceof` on it) and
// only mock the ceremony functions.
jest.mock('@/lib/auth/passkey', () => ({
  ...jest.requireActual('@/lib/auth/passkey'),
  createRegistrationOptions: jest.fn(),
  verifyRegistration: jest.fn(),
  verifyNativeRegistration: jest.fn(),
}));
jest.mock('@vercel/firewall');
jest.mock('@sentry/nextjs');
jest.mock('@/lib/admin/admin-action-audit');
jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/admin/step-up-store'),
  evaluateStepUp: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/notifications-worker-client', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/notifications-worker-client'),
  dispatchAccountSecurityPush: jest.fn(async () => true),
}));
jest.mock('@kilocode/web-shared/lib/email', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/email'),
  sendPasskeyAddedEmail: jest.fn(async () => ({ sent: true })),
  sendPasskeyEnrollmentCodeEmail: jest.fn(),
}));

import {
  getUserFromAuth,
  getUserFromSessionForCredentialIssuance,
} from '@kilocode/web-shared/lib/user/server';
import { evaluateStepUp } from '@kilocode/web-shared/lib/admin/step-up-store';
import { recordAdminAction } from '@/lib/admin/admin-action-audit';
import {
  createRegistrationOptions,
  verifyRegistration,
  verifyNativeRegistration,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';
import { mintPasskeyManagementAuthorization } from '@/lib/auth/passkey-management';
import { checkRateLimit } from '@vercel/firewall';
import { captureException, captureMessage } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  device_sessions,
  magic_link_tokens,
  passkey_credentials,
  passkey_management_authorizations,
  type User,
} from '@kilocode/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import {
  deleteTransactionalEmailLogForUsers,
  insertTestUser,
} from '@kilocode/web-shared/tests/helpers/user.helper';
import { dispatchAccountSecurityPush } from '@kilocode/web-shared/lib/notifications-worker-client';
import { sendPasskeyEnrollmentCodeEmail } from '@kilocode/web-shared/lib/email';
import { createPasskeyEnrollmentCode } from '@/lib/auth/passkey-enrollment-email-code';
import {
  buildRegistrationResponse,
  createTestAuthenticator,
} from '@/tests/helpers/webauthn-test-authenticator';
import type * as PasskeyModule from '@/lib/auth/passkey';
import { POST } from './route';
import { __test__ as rateLimitTest } from '@/lib/auth/firewall-rate-limit';

const actualPasskey = jest.requireActual<typeof PasskeyModule>('@/lib/auth/passkey');

const mockGetUserFromAuth = jest.mocked(getUserFromSessionForCredentialIssuance);
const mockGetBearerUser = jest.mocked(getUserFromAuth);
const mockEvaluateStepUp = jest.mocked(evaluateStepUp);
const mockRecordAdminAction = jest.mocked(recordAdminAction);
const mockCreateRegistrationOptions = jest.mocked(createRegistrationOptions);
const mockVerifyRegistration = jest.mocked(verifyRegistration);
const mockVerifyNativeRegistration = jest.mocked(verifyNativeRegistration);
const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockCaptureMessage = jest.mocked(captureMessage);
const mockCaptureException = jest.mocked(captureException);
const mockSendCodeEmail = jest.mocked(sendPasskeyEnrollmentCodeEmail);
const mockDispatchPush = jest.mocked(dispatchAccountSecurityPush);

/** The (recipient, event) of every security-notice push sent since the last clear. */
function noticePushes() {
  return mockDispatchPush.mock.calls.map(([push]) => [push.recipientUserId, push.event]);
}

const fakeUser = {
  id: 'user-1',
  google_user_email: 'user@example.com',
  google_user_name: 'User',
  is_admin: false,
  is_super_admin: false,
};

const challengeId = '11111111-1111-4111-8111-111111111111';

/** A well-formed code for tests whose ceremony is mocked and never checks it. */
const unusedEmailCode = { emailCodeId: '22222222-2222-4222-8222-222222222222', code: '123456' };

function passkeyEnrollmentRows(email: string) {
  return and(
    eq(magic_link_tokens.email, email),
    eq(magic_link_tokens.purpose, 'passkey_enrollment')
  );
}

/** A live code for `fakeUser` and its `session-1` browser session. */
async function mintFakeUserCode(): Promise<{ emailCodeId: string; code: string }> {
  const created = await createPasskeyEnrollmentCode({
    userId: fakeUser.id,
    email: fakeUser.google_user_email,
    webSessionId: 'session-1',
  });
  if (created.status !== 'created') throw new Error(`no enrollment code: ${created.status}`);
  return { emailCodeId: created.emailCodeId, code: created.code };
}

/** One attestation as the browser's credential API returns it, JSON-encoded. */
const attestation = {
  id: 'credential-1',
  rawId: 'credential-1',
  type: 'public-key',
  response: {
    clientDataJSON: 'client-data',
    attestationObject: 'attestation-object',
  },
  clientExtensionResults: {},
};

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/passkey/register', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The native app presents a bearer token; the cookie path never sets one. */
function createNativeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/passkey/register', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer native-token' },
  });
}

// An enrollment notice leaves an outbox row that references its user; a later
// suite in the same worker that deletes every user would hit it. Each suite
// that inserts users deletes those rows in its own afterAll, which runs before
// the worker setup's root afterAll closes the database connections.
const createdUserIds: string[] = [];

async function insertUser(fields: Partial<User> = {}): Promise<User> {
  const created = await insertTestUser(fields);
  createdUserIds.push(created.id);
  return created;
}

describe('POST /api/auth/passkey/register', () => {
  beforeEach(async () => {
    await db.delete(magic_link_tokens).where(passkeyEnrollmentRows(fakeUser.google_user_email));
    jest.clearAllMocks();
    rateLimitTest.resetReportThrottle();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
    mockGetUserFromAuth.mockResolvedValue({
      user: fakeUser,
      authFailedResponse: null,
      webSessionId: 'session-1',
      webSessionPepper: 'session-pepper-1',
      authenticatedAt: Math.floor(Date.now() / 1000),
    } as never);
  });

  it('refuses without a session', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never);

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it('returns registration options for a valid email code', async () => {
    const options = { challenge: 'stored-challenge', rp: { id: 'localhost' } };
    mockCreateRegistrationOptions.mockResolvedValue({ challengeId, options } as never);
    const emailCode = await mintFakeUserCode();

    const response = await POST(createRequest({ action: 'options', emailCode }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challengeId, options });
    expect(mockCheckRateLimit).toHaveBeenCalledWith('passkey-registration-options', {
      request: expect.any(NextRequest),
      rateLimitKey: 'passkey-register-options:user-1',
    });
    expect(mockCreateRegistrationOptions).toHaveBeenCalledWith('user-1', 'user@example.com');
  });

  it('rate limits the options action per user', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'RATE_LIMITED' });
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it.each([
    ['not-found', 'is not configured'],
    ['blocked', 'could not be evaluated'],
  ] as const)(
    'refuses minting when the registration limiter reports %s',
    async (error, message) => {
      mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error });

      const response = await POST(createRequest({ action: 'options' }));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'RATE_LIMIT_UNAVAILABLE' });
      expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        `Firewall rate limit 'passkey-registration-options' ${message}`,
        { level: 'error', tags: { source: 'passkey_register_options' } }
      );
    }
  );

  it('reports a not-found registration rule only once per interval', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });
    const params = { level: 'error', tags: { source: 'passkey_register_options' } };

    await POST(createRequest({ action: 'options' }));
    await POST(createRequest({ action: 'options' }));

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'passkey-registration-options' is not configured",
      params
    );
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('binds the credential to the session user, ignoring the request body', async () => {
    mockVerifyRegistration.mockResolvedValue({ credential_id: 'credential-1' } as never);

    const response = await POST(
      createRequest({
        action: 'verify',
        challengeId,
        // A field the boundary does not know is stripped, so the ceremony is
        // called with the validated attestation and the session user only.
        response: { ...attestation, kiloUserId: 'attacker-user' },
        emailCode: unusedEmailCode,
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ credentialId: 'credential-1' });
    expect(mockVerifyRegistration).toHaveBeenCalledWith(
      'user-1',
      challengeId,
      attestation,
      'session-pepper-1',
      {
        binding: { userId: 'user-1', email: 'user@example.com', webSessionId: 'session-1' },
        ...unusedEmailCode,
      }
    );
    expect(noticePushes()).toEqual([['user-1', 'passkey_added']]);
  });

  it('returns 400 for an invalid request', async () => {
    expect((await POST(createRequest({ action: 'nope' }))).status).toBe(400);
    expect(
      (await POST(createRequest({ action: 'verify', challengeId: 'not-a-uuid' }))).status
    ).toBe(400);
    expect((await POST(createRequest('not-an-object'))).status).toBe(400);
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('returns 400 without verifying a body that is not a WebAuthn attestation', async () => {
    const bodies = [
      // Only the inner response object: no credential id or type.
      { action: 'verify', challengeId, response: attestation.response },
      // A registration response without the attestation object has nothing to
      // verify.
      {
        action: 'verify',
        challengeId,
        response: { ...attestation, response: { clientDataJSON: 'client-data' } },
      },
      // Anything other than a public-key credential is not an attestation.
      { action: 'verify', challengeId, response: { ...attestation, type: 'password' } },
      // The credential API members must be strings, not objects or numbers.
      {
        action: 'verify',
        challengeId,
        response: {
          ...attestation,
          response: { ...attestation.response, clientDataJSON: 42 },
        },
      },
    ];

    for (const body of bodies) {
      expect((await POST(createRequest(body))).status).toBe(400);
    }
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it('returns 401 with the stable code when verification is refused', async () => {
    mockVerifyRegistration.mockRejectedValue(
      new PasskeyVerificationError('CHALLENGE_ALREADY_USED')
    );

    const response = await POST(
      createRequest({
        action: 'verify',
        challengeId,
        response: attestation,
        emailCode: unusedEmailCode,
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'CHALLENGE_ALREADY_USED' });
    expect(noticePushes()).toEqual([]);
  });

  it('refuses a stale admin enrollment without a fresh sign-in or step-up proof', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: { ...fakeUser, is_admin: true },
      authFailedResponse: null,
      webSessionId: 'session-1',
      authenticatedAt: Math.floor(Date.now() / 1000) - 20 * 60,
    } as never);
    mockEvaluateStepUp.mockResolvedValue({
      state: { status: 'required' },
      proof: null,
      passkeyCount: 0,
    } as never);

    const response = await POST(
      createRequest({ action: 'verify', challengeId, response: attestation })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'REAUTH_REQUIRED' });
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it('refuses the options step for a stale admin enrollment', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: { ...fakeUser, is_admin: true },
      authFailedResponse: null,
      webSessionId: 'session-1',
      authenticatedAt: Math.floor(Date.now() / 1000) - 20 * 60,
    } as never);
    mockEvaluateStepUp.mockResolvedValue({
      state: { status: 'required' },
      proof: null,
      passkeyCount: 1,
    } as never);

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'REAUTH_REQUIRED' });
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('allows an admin enrollment from a fresh sign-in', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: { ...fakeUser, is_admin: true },
      authFailedResponse: null,
      webSessionId: 'session-1',
      authenticatedAt: Math.floor(Date.now() / 1000) - 60,
    } as never);
    mockVerifyRegistration.mockResolvedValue({ credential_id: 'credential-1' } as never);

    const response = await POST(
      createRequest({
        action: 'verify',
        challengeId,
        response: attestation,
        emailCode: unusedEmailCode,
      })
    );

    expect(response.status).toBe(200);
    expect(mockEvaluateStepUp).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ trpcPath: '/api/auth/passkey/register' }),
      expect.objectContaining({ action: 'admin.passkey.enrolled' })
    );
  });

  it('allows an admin enrollment with a live step-up proof', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: { ...fakeUser, is_admin: true },
      authFailedResponse: null,
      webSessionId: 'session-1',
      authenticatedAt: Math.floor(Date.now() / 1000) - 20 * 60,
    } as never);
    mockEvaluateStepUp.mockResolvedValue({
      state: {
        status: 'fresh',
        method: 'webauthn_uv',
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      proof: null,
      passkeyCount: 1,
    } as never);
    mockVerifyRegistration.mockResolvedValue({ credential_id: 'credential-1' } as never);

    const response = await POST(
      createRequest({
        action: 'verify',
        challengeId,
        response: attestation,
        emailCode: unusedEmailCode,
      })
    );

    expect(response.status).toBe(200);
  });

  it('refuses an enrollment from a session that signed in too long ago', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: fakeUser,
      authFailedResponse: null,
      webSessionId: 'session-1',
      authenticatedAt: Math.floor(Date.now() / 1000) - 20 * 60,
    } as never);
    mockEvaluateStepUp.mockResolvedValue({
      state: { status: 'required' },
      proof: null,
      passkeyCount: 0,
    } as never);

    const verify = await POST(
      createRequest({ action: 'verify', challengeId, response: attestation })
    );

    expect(verify.status).toBe(401);
    expect(await verify.json()).toEqual({ error: 'REAUTH_REQUIRED' });
    expect(mockVerifyRegistration).not.toHaveBeenCalled();

    const options = await POST(createRequest({ action: 'options' }));

    expect(options.status).toBe(401);
    expect(await options.json()).toEqual({ error: 'REAUTH_REQUIRED' });
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).not.toHaveBeenCalled();
  });

  it('refuses a session with no sign-in time and no web session id', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: fakeUser,
      authFailedResponse: null,
    } as never);

    const response = await POST(
      createRequest({ action: 'verify', challengeId, response: attestation })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'REAUTH_REQUIRED' });
    expect(mockEvaluateStepUp).not.toHaveBeenCalled();
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it('allows an enrollment right after a sign-in', async () => {
    mockVerifyRegistration.mockResolvedValue({ credential_id: 'credential-1' } as never);

    const response = await POST(
      createRequest({
        action: 'verify',
        challengeId,
        response: attestation,
        emailCode: unusedEmailCode,
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ credentialId: 'credential-1' });
    expect(mockEvaluateStepUp).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).not.toHaveBeenCalled();
  });

  it('allows an enrollment with a live step-up proof', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: fakeUser,
      authFailedResponse: null,
      webSessionId: 'session-1',
      authenticatedAt: Math.floor(Date.now() / 1000) - 20 * 60,
    } as never);
    mockEvaluateStepUp.mockResolvedValue({
      state: {
        status: 'fresh',
        method: 'webauthn_uv',
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      proof: null,
      passkeyCount: 1,
    } as never);
    mockCreateRegistrationOptions.mockResolvedValue({
      challengeId,
      options: { challenge: 'stored-challenge' },
    } as never);

    const response = await POST(
      createRequest({ action: 'options', emailCode: await mintFakeUserCode() })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      challengeId,
      options: { challenge: 'stored-challenge' },
    });
  });

  it('fails closed when the freshness lookup cannot answer', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: fakeUser,
      authFailedResponse: null,
      webSessionId: 'session-1',
      authenticatedAt: Math.floor(Date.now() / 1000) - 20 * 60,
    } as never);
    mockEvaluateStepUp.mockRejectedValue(new Error('drizzle down'));

    const response = await POST(
      createRequest({ action: 'verify', challengeId, response: attestation })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'STEP_UP_UNAVAILABLE' });
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/passkey/register (native app)', () => {
  let user: User;
  let deviceSessionId: string;

  afterAll(() => deleteTransactionalEmailLogForUsers(createdUserIds));

  beforeEach(async () => {
    jest.clearAllMocks();
    rateLimitTest.resetReportThrottle();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
    user = await insertUser();
    const [session] = await db
      .insert(device_sessions)
      .values({ kilo_user_id: user.id })
      .returning({ id: device_sessions.id });
    deviceSessionId = session!.id;
    mockGetBearerUser.mockResolvedValue({
      user,
      authFailedResponse: null,
      credential: 'human_bearer',
      authViaToken: true,
      deviceSessionId,
    } as never);
  });

  async function mintGrant(operation: 'enroll' | 'rename' | 'remove' = 'enroll') {
    return mintPasskeyManagementAuthorization({
      userId: user.id,
      deviceSessionId,
      operation,
    });
  }

  it('refuses an ordinary API key bearer before any ceremony work', async () => {
    mockGetBearerUser.mockResolvedValue({
      user,
      authFailedResponse: null,
      credential: 'human_bearer',
      authViaToken: true,
    } as never);

    const response = await POST(
      createNativeRequest({ action: 'options', managementAuthorization: 'grant' })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED' });
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
    expect(mockVerifyNativeRegistration).not.toHaveBeenCalled();
  });

  it('requires the management grant on both registration steps', async () => {
    const options = await POST(createNativeRequest({ action: 'options' }));
    expect(options.status).toBe(403);
    expect(await options.json()).toEqual({ error: 'PASSKEY_MANAGEMENT_REQUIRED' });

    const verify = await POST(
      createNativeRequest({ action: 'verify', challengeId, response: attestation })
    );
    expect(verify.status).toBe(403);
    expect(await verify.json()).toEqual({ error: 'PASSKEY_MANAGEMENT_REQUIRED' });

    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
    expect(mockVerifyNativeRegistration).not.toHaveBeenCalled();
    expect(noticePushes()).toEqual([]);
  });

  it('requires the grant before an admin enrollment too', async () => {
    const admin = await insertUser({ is_admin: true });
    const [session] = await db
      .insert(device_sessions)
      .values({ kilo_user_id: admin.id })
      .returning({ id: device_sessions.id });
    mockGetBearerUser.mockResolvedValue({
      user: admin,
      authFailedResponse: null,
      credential: 'human_bearer',
      authViaToken: true,
      deviceSessionId: session!.id,
    } as never);

    const response = await POST(
      createNativeRequest({ action: 'verify', challengeId, response: attestation })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'PASSKEY_MANAGEMENT_REQUIRED' });
    expect(mockVerifyNativeRegistration).not.toHaveBeenCalled();
  });

  it('refuses an enrollment grant minted for another operation', async () => {
    const removal = await mintGrant('remove');

    const response = await POST(
      createNativeRequest({ action: 'options', managementAuthorization: removal.token })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'PASSKEY_MANAGEMENT_AUTHORIZATION_INVALID',
    });
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('refuses both steps once the device session is revoked', async () => {
    const grant = await mintGrant();
    mockCreateRegistrationOptions.mockResolvedValue({
      challengeId,
      options: { challenge: 'stored-challenge' },
    } as never);
    await db
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(device_sessions.id, deviceSessionId));

    const options = await POST(
      createNativeRequest({ action: 'options', managementAuthorization: grant.token })
    );
    expect(options.status).toBe(401);
    expect(await options.json()).toEqual({
      error: 'PASSKEY_MANAGEMENT_AUTHORIZATION_INVALID',
    });

    const verify = await POST(
      createNativeRequest({
        action: 'verify',
        challengeId,
        response: attestation,
        managementAuthorization: grant.token,
      })
    );
    expect(verify.status).toBe(401);
    expect(await verify.json()).toEqual({
      error: 'PASSKEY_MANAGEMENT_AUTHORIZATION_INVALID',
    });

    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
    expect(mockVerifyNativeRegistration).not.toHaveBeenCalled();
  });

  it('binds the minted challenge to the grant', async () => {
    const grant = await mintGrant();
    mockCreateRegistrationOptions.mockResolvedValue({
      challengeId,
      options: { challenge: 'stored-challenge' },
    } as never);

    const response = await POST(
      createNativeRequest({ action: 'options', managementAuthorization: grant.token })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      challengeId,
      options: { challenge: 'stored-challenge' },
    });
    const [row] = await db
      .select({ passkey_challenge_id: passkey_management_authorizations.passkey_challenge_id })
      .from(passkey_management_authorizations)
      .where(eq(passkey_management_authorizations.id, grant.id));
    expect(row?.passkey_challenge_id).toBe(challengeId);
  });

  it('spends the grant on a successful verify and refuses its replay', async () => {
    const grant = await mintGrant();
    mockCreateRegistrationOptions.mockResolvedValue({
      challengeId,
      options: { challenge: 'stored-challenge' },
    } as never);
    await POST(createNativeRequest({ action: 'options', managementAuthorization: grant.token }));

    mockVerifyNativeRegistration.mockImplementation(
      async (_userId, _challenge, _response, consume) => {
        if (!(await consume(db as never))) {
          throw new PasskeyVerificationError('PASSKEY_MANAGEMENT_AUTHORIZATION_INVALID');
        }
        return { credential_id: 'credential-1' } as never;
      }
    );

    const first = await POST(
      createNativeRequest({
        action: 'verify',
        challengeId,
        response: attestation,
        managementAuthorization: grant.token,
      })
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ credentialId: 'credential-1' });

    const replay = await POST(
      createNativeRequest({
        action: 'verify',
        challengeId,
        response: attestation,
        managementAuthorization: grant.token,
      })
    );
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({
      error: 'PASSKEY_MANAGEMENT_AUTHORIZATION_INVALID',
    });
    expect(mockVerifyNativeRegistration).toHaveBeenCalledTimes(1);
    // One notice for the enrollment, none for the refused replay.
    expect(noticePushes()).toEqual([[user.id, 'passkey_added']]);
  });

  it('audits an admin enrollment from the native path as a bearer enrollment', async () => {
    const admin = await insertUser({ is_admin: true });
    const [session] = await db
      .insert(device_sessions)
      .values({ kilo_user_id: admin.id })
      .returning({ id: device_sessions.id });
    const adminSessionId = session!.id;
    mockGetBearerUser.mockResolvedValue({
      user: admin,
      authFailedResponse: null,
      credential: 'human_bearer',
      authViaToken: true,
      deviceSessionId: adminSessionId,
    } as never);
    const grant = await mintPasskeyManagementAuthorization({
      userId: admin.id,
      deviceSessionId: adminSessionId,
      operation: 'enroll',
    });
    mockCreateRegistrationOptions.mockResolvedValue({
      challengeId,
      options: { challenge: 'stored-challenge' },
    } as never);
    await POST(createNativeRequest({ action: 'options', managementAuthorization: grant.token }));

    mockVerifyNativeRegistration.mockImplementation(
      async (_userId, _challenge, _response, consume) => {
        if (!(await consume(db as never))) {
          throw new PasskeyVerificationError('PASSKEY_MANAGEMENT_AUTHORIZATION_INVALID');
        }
        return { credential_id: 'credential-admin' } as never;
      }
    );

    const response = await POST(
      createNativeRequest({
        action: 'verify',
        challengeId,
        response: attestation,
        managementAuthorization: grant.token,
      })
    );

    expect(response.status).toBe(200);
    expect(mockRecordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: 'human_bearer',
        authViaToken: true,
        trpcPath: '/api/auth/passkey/register',
        user: expect.objectContaining({ id: admin.id }),
      }),
      expect.objectContaining({ action: 'admin.passkey.enrolled' })
    );
  });
});

describe('POST /api/auth/passkey/register (browser email code)', () => {
  const sessionPepper = 'browser-session-pepper';
  let user: User;

  afterAll(() => deleteTransactionalEmailLogForUsers(createdUserIds));

  function signIn(webSessionId: string, authenticatedAt = Math.floor(Date.now() / 1000)) {
    mockGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
      webSessionId,
      webSessionPepper: sessionPepper,
      authenticatedAt,
    } as never);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    rateLimitTest.resetReportThrottle();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
    mockCreateRegistrationOptions.mockImplementation(actualPasskey.createRegistrationOptions);
    mockVerifyRegistration.mockImplementation(actualPasskey.verifyRegistration);
    mockSendCodeEmail.mockResolvedValue({ sent: true });
    user = await insertUser({ web_session_pepper: sessionPepper });
    signIn('browser-session-a');
  });

  afterEach(() => {
    mockCreateRegistrationOptions.mockReset();
    mockVerifyRegistration.mockReset();
  });

  async function sendCode(): Promise<{ emailCodeId: string; code: string }> {
    const response = await POST(createRequest({ action: 'send_code' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { emailCodeId: string };
    const code = mockSendCodeEmail.mock.calls.at(-1)?.[1].code;
    if (!code) throw new Error('no code email was sent');
    return { emailCodeId: body.emailCodeId, code };
  }

  function wrongCode(code: string): string {
    return String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  }

  async function codeRows() {
    return db
      .select({
        challenge_id: magic_link_tokens.challenge_id,
        consumed_at: magic_link_tokens.consumed_at,
      })
      .from(magic_link_tokens)
      .where(passkeyEnrollmentRows(user.google_user_email));
  }

  async function passkeyCount(): Promise<number> {
    const rows = await db
      .select({ id: passkey_credentials.id })
      .from(passkey_credentials)
      .where(eq(passkey_credentials.kilo_user_id, user.id));
    return rows.length;
  }

  it('emails a code to the account address without returning it', async () => {
    const response = await POST(createRequest({ action: 'send_code' }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      emailCodeId: expect.any(String),
      expiresInSeconds: 600,
      email: user.google_user_email,
    });
    expect(mockSendCodeEmail).toHaveBeenCalledTimes(1);
    expect(mockSendCodeEmail).toHaveBeenCalledWith(user.google_user_email, {
      code: expect.stringMatching(/^\d{6}$/),
      expiresInMinutes: 10,
    });
    expect(mockCheckRateLimit).toHaveBeenCalledWith('passkey-registration-options', {
      request: expect.any(NextRequest),
      rateLimitKey: `passkey-register-options:${user.id}`,
    });
  });

  it('sends no code to a session that is not fresh', async () => {
    signIn('browser-session-a', Math.floor(Date.now() / 1000) - 20 * 60);
    mockEvaluateStepUp.mockResolvedValue({
      state: { status: 'required' },
      proof: null,
      passkeyCount: 0,
    } as never);

    const response = await POST(createRequest({ action: 'send_code' }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'REAUTH_REQUIRED' });
    expect(mockSendCodeEmail).not.toHaveBeenCalled();
    expect(await codeRows()).toEqual([]);
  });

  it('asks for the email code on options and verify', async () => {
    const options = await POST(createRequest({ action: 'options' }));
    expect(options.status).toBe(401);
    expect(await options.json()).toEqual({ error: 'EMAIL_CODE_REQUIRED' });

    const verify = await POST(
      createRequest({ action: 'verify', challengeId, response: attestation })
    );
    expect(verify.status).toBe(401);
    expect(await verify.json()).toEqual({ error: 'EMAIL_CODE_REQUIRED' });

    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
    expect(noticePushes()).toEqual([]);
  });

  it('counts wrong codes, locks at the fifth, and sends no code while locked', async () => {
    const emailCode = await sendCode();
    const wrong = { ...emailCode, code: wrongCode(emailCode.code) };

    for (const attemptsLeft of [4, 3, 2, 1]) {
      const response = await POST(createRequest({ action: 'options', emailCode: wrong }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'EMAIL_CODE_INVALID', attemptsLeft });
    }

    const fifth = await POST(createRequest({ action: 'options', emailCode: wrong }));
    expect(fifth.status).toBe(429);
    expect(await fifth.json()).toEqual({ error: 'EMAIL_CODE_LOCKED', retryAfterSeconds: 900 });

    const correct = await POST(createRequest({ action: 'options', emailCode }));
    expect(correct.status).toBe(429);
    expect(await correct.json()).toMatchObject({ error: 'EMAIL_CODE_LOCKED' });

    const resend = await POST(createRequest({ action: 'send_code' }));
    expect(resend.status).toBe(429);
    const resendBody = (await resend.json()) as { error: string; retryAfterSeconds: number };
    expect(resendBody.error).toBe('EMAIL_CODE_LOCKED');
    expect(resendBody.retryAfterSeconds).toBeGreaterThan(890);
    expect(resendBody.retryAfterSeconds).toBeLessThanOrEqual(900);
    expect(mockSendCodeEmail).toHaveBeenCalledTimes(1);
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('refuses an expired code as expired, so the client sends a new one', async () => {
    const emailCode = await sendCode();
    await db
      .update(magic_link_tokens)
      .set({
        created_at: sql`${magic_link_tokens.created_at} - interval '11 minutes'`,
        expires_at: sql`${magic_link_tokens.expires_at} - interval '11 minutes'`,
      })
      .where(eq(magic_link_tokens.challenge_id, emailCode.emailCodeId));

    const response = await POST(createRequest({ action: 'options', emailCode }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'EMAIL_CODE_EXPIRED' });
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('refuses a code minted for another browser session', async () => {
    const emailCode = await sendCode();
    signIn('browser-session-b');

    const response = await POST(createRequest({ action: 'options', emailCode }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'EMAIL_CODE_INVALID', attemptsLeft: 4 });
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('deletes the code when its email is definitely not sent', async () => {
    mockSendCodeEmail.mockResolvedValueOnce({ sent: false, reason: 'provider_not_configured' });
    const notConfigured = await POST(createRequest({ action: 'send_code' }));
    expect(notConfigured.status).toBe(502);
    expect(await notConfigured.json()).toEqual({ error: 'EMAIL_DELIVERY_FAILED' });
    expect(await codeRows()).toEqual([]);

    mockSendCodeEmail.mockResolvedValueOnce({ sent: false, reason: 'neverbounce_rejected' });
    const undeliverable = await POST(createRequest({ action: 'send_code' }));
    expect(undeliverable.status).toBe(422);
    expect(await undeliverable.json()).toEqual({ error: 'EMAIL_UNDELIVERABLE' });
    expect(await codeRows()).toEqual([]);
  });

  it('keeps a code whose send threw counted for the cooldown, but not redeemable', async () => {
    mockSendCodeEmail.mockRejectedValueOnce(new Error('provider down'));
    const threw = await POST(createRequest({ action: 'send_code' }));
    expect(threw.status).toBe(502);
    expect(await threw.json()).toEqual({ error: 'EMAIL_DELIVERY_FAILED' });
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: 'passkey_enrollment_code_email' },
    });

    const rows = await codeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumed_at).toBeNull();
    const code = mockSendCodeEmail.mock.calls.at(-1)?.[1].code;
    if (!code || !rows[0]?.challenge_id) throw new Error('no thrown code row');

    const redeem = await POST(
      createRequest({
        action: 'options',
        emailCode: { emailCodeId: rows[0].challenge_id, code },
      })
    );
    expect(redeem.status).toBe(401);
    expect(await redeem.json()).toEqual({ error: 'EMAIL_CODE_EXPIRED' });

    const resend = await POST(createRequest({ action: 'send_code' }));
    expect(resend.status).toBe(429);
    expect(await resend.json()).toMatchObject({ error: 'EMAIL_CODE_COOLDOWN' });
    expect(mockSendCodeEmail).toHaveBeenCalledTimes(1);
  });

  it('counts codes whose send threw toward the hourly limit', async () => {
    for (let send = 0; send < 5; send += 1) {
      mockSendCodeEmail.mockRejectedValueOnce(new Error('provider down'));
      const threw = await POST(createRequest({ action: 'send_code' }));
      expect(threw.status).toBe(502);
      await db
        .update(magic_link_tokens)
        .set({ created_at: sql`${magic_link_tokens.created_at} - interval '2 minutes'` })
        .where(passkeyEnrollmentRows(user.google_user_email));
    }

    const response = await POST(createRequest({ action: 'send_code' }));

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe('EMAIL_CODE_HOURLY_LIMIT');
    expect(body.retryAfterSeconds).toBeGreaterThan(50 * 60 - 10);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(50 * 60);
    expect(response.headers.get('Retry-After')).toBe(String(body.retryAfterSeconds));
    expect(mockSendCodeEmail).toHaveBeenCalledTimes(5);
  });

  it('holds a new code for the resend cooldown', async () => {
    await sendCode();

    const response = await POST(createRequest({ action: 'send_code' }));

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe('EMAIL_CODE_COOLDOWN');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(response.headers.get('Retry-After')).toBe(String(body.retryAfterSeconds));
    expect(mockSendCodeEmail).toHaveBeenCalledTimes(1);
  });

  it('enrolls with the emailed code and spends it on the first passkey', async () => {
    const emailCode = await sendCode();

    // A cancelled ceremony asks for options again with the same code.
    const cancelled = await POST(createRequest({ action: 'options', emailCode }));
    expect(cancelled.status).toBe(200);
    const retried = await POST(createRequest({ action: 'options', emailCode }));
    expect(retried.status).toBe(200);
    const first = (await cancelled.json()) as {
      challengeId: string;
      options: { challenge: string };
    };
    const second = (await retried.json()) as {
      challengeId: string;
      options: { challenge: string };
    };

    // A wrong code is refused before the ceremony: no passkey and no notice.
    const wrongVerify = await POST(
      createRequest({
        action: 'verify',
        challengeId: second.challengeId,
        response: buildRegistrationResponse(createTestAuthenticator(), {
          challenge: second.options.challenge,
        }),
        emailCode: { ...emailCode, code: wrongCode(emailCode.code) },
      })
    );
    expect(wrongVerify.status).toBe(401);
    expect(await wrongVerify.json()).toEqual({ error: 'EMAIL_CODE_INVALID', attemptsLeft: 4 });
    expect(await passkeyCount()).toBe(0);
    expect(noticePushes()).toEqual([]);

    const verify = await POST(
      createRequest({
        action: 'verify',
        challengeId: second.challengeId,
        response: buildRegistrationResponse(createTestAuthenticator(), {
          challenge: second.options.challenge,
        }),
        emailCode,
      })
    );
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ credentialId: expect.any(String) });
    expect(await codeRows()).toEqual([
      { challenge_id: emailCode.emailCodeId, consumed_at: expect.any(String) },
    ]);
    expect(noticePushes()).toEqual([[user.id, 'passkey_added']]);

    const optionsAgain = await POST(createRequest({ action: 'options', emailCode }));
    expect(optionsAgain.status).toBe(401);
    expect(await optionsAgain.json()).toEqual({ error: 'EMAIL_CODE_EXPIRED' });

    const secondPasskey = await POST(
      createRequest({
        action: 'verify',
        challengeId: first.challengeId,
        response: buildRegistrationResponse(createTestAuthenticator(), {
          challenge: first.options.challenge,
        }),
        emailCode,
      })
    );
    expect(secondPasskey.status).toBe(401);
    expect(await secondPasskey.json()).toEqual({ error: 'EMAIL_CODE_EXPIRED' });
    expect(await passkeyCount()).toBe(1);
    // One notice for the one enrollment; the refused second passkey sends none.
    expect(noticePushes()).toEqual([[user.id, 'passkey_added']]);
  });
});
