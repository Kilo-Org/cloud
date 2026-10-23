import { NextRequest, NextResponse } from 'next/server';

jest.mock('@kilocode/web-shared/lib/user/server');
// Keep the real PasskeyVerificationError (the route uses `instanceof` on it) and
// only mock the ceremony functions.
jest.mock('@/lib/auth/passkey', () => ({
  ...jest.requireActual('@/lib/auth/passkey'),
  createRegistrationOptions: jest.fn(),
  verifyRegistration: jest.fn(),
}));

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  createRegistrationOptions,
  verifyRegistration,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';
import { POST } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockCreateRegistrationOptions = jest.mocked(createRegistrationOptions);
const mockVerifyRegistration = jest.mocked(verifyRegistration);

const fakeUser = { id: 'user-1', google_user_email: 'user@example.com' };

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

describe('POST /api/auth/passkey/register', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({
      user: fakeUser,
      authFailedResponse: null,
    } as never);
  });

  it('refuses without a session', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never);

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(401);
    expect(mockCreateRegistrationOptions).not.toHaveBeenCalled();
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  it('returns registration options', async () => {
    const options = { challenge: 'stored-challenge', rp: { id: 'localhost' } };
    mockCreateRegistrationOptions.mockResolvedValue({ challengeId, options } as never);

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challengeId, options });
    expect(mockCreateRegistrationOptions).toHaveBeenCalledWith('user-1', 'user@example.com');
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
    expect(mockVerifyRegistration).toHaveBeenCalledWith('user-1', challengeId, attestation);
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
});
