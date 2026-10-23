import { NextRequest } from 'next/server';

// Keep the real PasskeyVerificationError (the route uses `instanceof` on it) and
// only mock the ceremony functions.
jest.mock('@/lib/auth/passkey', () => ({
  ...jest.requireActual('@/lib/auth/passkey'),
  createAuthenticationOptions: jest.fn(),
  verifyAuthentication: jest.fn(),
}));
jest.mock('@vercel/firewall');
jest.mock('@sentry/nextjs');

import {
  createAuthenticationOptions,
  verifyAuthentication,
  PasskeyVerificationError,
} from '@/lib/auth/passkey';
import { checkRateLimit } from '@vercel/firewall';
import { POST } from './route';

const mockCreateAuthenticationOptions = jest.mocked(createAuthenticationOptions);
const mockVerifyAuthentication = jest.mocked(verifyAuthentication);
const mockCheckRateLimit = jest.mocked(checkRateLimit);

const challengeId = '22222222-2222-4222-8222-222222222222';

/** One assertion as the browser's credential API returns it, JSON-encoded. */
const assertion = {
  id: 'credential-1',
  rawId: 'credential-1',
  type: 'public-key',
  response: {
    clientDataJSON: 'client-data',
    authenticatorData: 'authenticator-data',
    signature: 'signature',
  },
  clientExtensionResults: {},
};

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/passkey/authenticate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
  });
}

describe('POST /api/auth/passkey/authenticate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
  });

  it('returns usernameless authentication options without a session', async () => {
    const options = { challenge: 'stored-challenge', allowCredentials: [] };
    mockCreateAuthenticationOptions.mockResolvedValue({ challengeId, options } as never);

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challengeId, options });
    expect(mockCreateAuthenticationOptions).toHaveBeenCalledWith();
  });

  it('rate limits the unauthenticated options action', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'RATE_LIMITED' });
    expect(mockCheckRateLimit).toHaveBeenCalledWith('passkey-authentication-options', {
      request: expect.any(NextRequest),
      rateLimitKey: 'passkey-options:203.0.113.7',
    });
    expect(mockCreateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it('returns a sign-in ticket for a verified assertion', async () => {
    mockVerifyAuthentication.mockResolvedValue({ ticket: 'one-time-ticket' });

    const response = await POST(
      createRequest({ action: 'verify', challengeId, response: assertion })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ticket: 'one-time-ticket' });
    expect(mockVerifyAuthentication).toHaveBeenCalledWith(challengeId, assertion);
  });

  it('returns 400 for an invalid request', async () => {
    expect((await POST(createRequest(undefined))).status).toBe(400);
    expect((await POST(createRequest({ action: 'verify' }))).status).toBe(400);
    expect(mockCreateAuthenticationOptions).not.toHaveBeenCalled();
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
  });

  it('returns 400 without verifying a body that is not a WebAuthn assertion', async () => {
    const bodies = [
      // Only the inner response object: no credential id or type.
      { action: 'verify', challengeId, response: assertion.response },
      // A credential id but no raw id to compare it with.
      {
        action: 'verify',
        challengeId,
        response: { ...assertion, rawId: undefined },
      },
      // Anything other than a public-key credential is not an assertion.
      { action: 'verify', challengeId, response: { ...assertion, type: 'password' } },
      // The credential API members must be strings, not objects or numbers.
      {
        action: 'verify',
        challengeId,
        response: {
          ...assertion,
          response: { ...assertion.response, signature: 42 },
        },
      },
    ];

    for (const body of bodies) {
      expect((await POST(createRequest(body))).status).toBe(400);
    }
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
  });

  it('accepts an assertion from a native authenticator that omits client extension results', async () => {
    mockVerifyAuthentication.mockResolvedValue({ ticket: 'one-time-ticket' });
    const { clientExtensionResults: _omitted, ...nativeAssertion } = assertion;

    const response = await POST(
      createRequest({ action: 'verify', challengeId, response: nativeAssertion })
    );

    expect(response.status).toBe(200);
    // The verifier never reads extension outputs, so absence is normalized to
    // the empty set rather than handed on as undefined.
    expect(mockVerifyAuthentication).toHaveBeenCalledWith(challengeId, assertion);
  });

  it('returns 401 with the stable code when the assertion is refused', async () => {
    mockVerifyAuthentication.mockRejectedValue(new PasskeyVerificationError('UNKNOWN_CREDENTIAL'));

    const response = await POST(
      createRequest({ action: 'verify', challengeId, response: assertion })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'UNKNOWN_CREDENTIAL' });
  });
});
