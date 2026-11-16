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
import { captureMessage } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions, passkey_management_authorizations, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { POST } from './route';
import { __test__ as rateLimitTest } from '@/lib/auth/firewall-rate-limit';

const mockGetUserFromAuth = jest.mocked(getUserFromSessionForCredentialIssuance);
const mockGetBearerUser = jest.mocked(getUserFromAuth);
const mockEvaluateStepUp = jest.mocked(evaluateStepUp);
const mockRecordAdminAction = jest.mocked(recordAdminAction);
const mockCreateRegistrationOptions = jest.mocked(createRegistrationOptions);
const mockVerifyRegistration = jest.mocked(verifyRegistration);
const mockVerifyNativeRegistration = jest.mocked(verifyNativeRegistration);
const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockCaptureMessage = jest.mocked(captureMessage);

const fakeUser = {
  id: 'user-1',
  google_user_email: 'user@example.com',
  google_user_name: 'User',
  is_admin: false,
  is_super_admin: false,
};

const challengeId = '11111111-1111-4111-8111-111111111111';

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

describe('POST /api/auth/passkey/register', () => {
  beforeEach(() => {
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

  it('returns registration options', async () => {
    const options = { challenge: 'stored-challenge', rp: { id: 'localhost' } };
    mockCreateRegistrationOptions.mockResolvedValue({ challengeId, options } as never);

    const response = await POST(createRequest({ action: 'options' }));

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
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ credentialId: 'credential-1' });
    expect(mockVerifyRegistration).toHaveBeenCalledWith(
      'user-1',
      challengeId,
      attestation,
      'session-pepper-1'
    );
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
      createRequest({ action: 'verify', challengeId, response: attestation })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'CHALLENGE_ALREADY_USED' });
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
      createRequest({ action: 'verify', challengeId, response: attestation })
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
      createRequest({ action: 'verify', challengeId, response: attestation })
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
      createRequest({ action: 'verify', challengeId, response: attestation })
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

    const response = await POST(createRequest({ action: 'options' }));

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

  beforeEach(async () => {
    jest.clearAllMocks();
    rateLimitTest.resetReportThrottle();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
    user = await insertTestUser();
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
  });

  it('requires the grant before an admin enrollment too', async () => {
    const admin = await insertTestUser({ is_admin: true });
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
  });

  it('audits an admin enrollment from the native path as a bearer enrollment', async () => {
    const admin = await insertTestUser({ is_admin: true });
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
