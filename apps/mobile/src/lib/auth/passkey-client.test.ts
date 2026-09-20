/* eslint-disable max-lines -- one suite for the sign-in and registration ceremonies, the platform error classification, and the copy mapping */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type PasskeysApi } from '@/lib/auth/passkey-client';

vi.mock('@/lib/auth/auth-fetch', () => ({ postAuth: vi.fn() }));

vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: vi.fn() }));

vi.mock('@/lib/auth/resolve-admission', () => ({ resolveAdmission: vi.fn() }));

const { postAuth } = await import('@/lib/auth/auth-fetch');
const { getAuthTokenForRequest } = await import('@/lib/auth/token-owner');
const { resolveAdmission } = await import('@/lib/auth/resolve-admission');

const {
  classifyPasskeyError,
  passkeyFailureKey,
  passkeysSupported,
  registerPasskey,
  signInWithPasskey,
} = await import('@/lib/auth/passkey-client');

const mockPostAuth = vi.mocked(postAuth);

function fakeApi(supported = true) {
  return {
    isSupported: () => supported,
    get: vi.fn<PasskeysApi['get']>(),
    create: vi.fn<PasskeysApi['create']>(),
  };
}

/** A server refusal, in the shape postAuth returns. */
function refused(errorCode?: string) {
  return { ok: false as const, errorCode, ssoOrganizationId: undefined };
}

const assertion = { id: 'cred-1', type: 'public-key', response: {} };
const attestation = { id: 'cred-2', type: 'public-key', response: {} };

const optionsResponse = {
  ok: true as const,
  data: { challengeId: 'c0000000-0000-4000-8000-000000000001', options: { challenge: 'chal' } },
};

const ticketResponse = { ok: true as const, data: { ticket: 'ticket-1' } };

const tokenResponse = {
  ok: true as const,
  data: { token: 'at', refreshToken: 'rt', expiresIn: 3600, created: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthTokenForRequest).mockResolvedValue('session-token');
  vi.mocked(resolveAdmission).mockResolvedValue({ admission: undefined });
});

describe('classifyPasskeyError', () => {
  it('reads the Android rejection strings', () => {
    expect(classifyPasskeyError({ code: 'Passkey Get', message: 'UserCancelled' })).toBe(
      'cancelled'
    );
    expect(classifyPasskeyError({ code: 'Passkey Get', message: 'NoCredentials' })).toBe(
      'no-passkey'
    );
    expect(classifyPasskeyError({ code: 'Passkey Get', message: 'Interrupted' })).toBe('failed');
    expect(classifyPasskeyError({ code: 'Passkey Get', message: 'UnknownError' })).toBe('failed');
    expect(classifyPasskeyError({ code: 'Passkey Create', message: 'NotSupported' })).toBe(
      'unsupported'
    );
    expect(classifyPasskeyError({ code: 'Passkey Create', message: 'NotConfigured' })).toBe(
      'unsupported'
    );
  });

  it('reads the Android DOM error types', () => {
    expect(
      classifyPasskeyError({
        code: 'Passkey Get',
        message: 'DomError: NotAllowedError - The operation is not allowed',
      })
    ).toBe('no-passkey');
  });

  it('reads the iOS exception names', () => {
    expect(classifyPasskeyError({ name: 'UserCancelledException' })).toBe('cancelled');
    expect(classifyPasskeyError({ name: 'NotConfiguredException' })).toBe('unsupported');
    expect(classifyPasskeyError({ name: 'NotSupportedException' })).toBe('unsupported');
    expect(classifyPasskeyError({ name: 'PasskeyRequestFailedException' })).toBe('failed');
    expect(classifyPasskeyError({ name: 'PasskeyAuthorizationFailedException' })).toBe('failed');
    expect(classifyPasskeyError({ name: 'InvalidChallengeException' })).toBe('failed');
    expect(classifyPasskeyError({ name: 'BiometricException' })).toBe('failed');
    expect(classifyPasskeyError({ name: 'PendingPasskeyRequestException' })).toBe('failed');
  });

  it('reads the reason in the iOS message as well as the name', () => {
    expect(
      classifyPasskeyError({
        name: 'Error',
        message: 'User cancelled the passkey interaction',
      })
    ).toBe('cancelled');
  });

  it('reads the library error thrown before the native call', () => {
    expect(
      classifyPasskeyError({ name: 'NotSupportedError', message: 'Passkey are not supported' })
    ).toBe('unsupported');
  });

  it('matches case-insensitively', () => {
    expect(classifyPasskeyError({ message: 'USER  CANCELLED' })).toBe('cancelled');
    expect(classifyPasskeyError({ message: 'nocredentials' })).toBe('no-passkey');
  });

  it.each(['name', 'message', 'code'])(
    'classifies ASCII protocol errors in %s independently of the locale',
    field => {
      expect(classifyPasskeyError({ [field]: 'USERCANCELLED' })).toBe('cancelled');
      expect(classifyPasskeyError({ [field]: 'NOCREDENTIALS' })).toBe('no-passkey');
      expect(classifyPasskeyError({ [field]: 'NOTALLOWEDERROR' })).toBe('no-passkey');
      expect(classifyPasskeyError({ [field]: 'NOTSUPPORTEDEXCEPTION' })).toBe('unsupported');
      expect(classifyPasskeyError({ [field]: 'NOTCONFIGUREDEXCEPTION' })).toBe('unsupported');
    }
  );

  it.each([
    [{ name: 'USERCANCELLEDEXCEPTION' }, 'login.passkeyCancelled'],
    [{ message: 'NOCREDENTIALS' }, 'login.passkeyNotFound'],
    [{ name: 'NOTALLOWEDERROR' }, 'login.passkeyNotFound'],
    [{ code: 'NOTCONFIGURED' }, 'login.passkeyUnsupported'],
    [{ message: 'NOTSUPPORTED' }, 'login.passkeyUnsupported'],
    [{ code: 'UNKNOWNERROR' }, 'login.passkeyFailed'],
  ])('maps native error %j to catalog-owned copy', (nativeError, key) => {
    expect(passkeyFailureKey(classifyPasskeyError(nativeError))).toBe(key);
  });

  it('falls back to the generic failure for anything else', () => {
    expect(classifyPasskeyError(new Error('socket closed'))).toBe('failed');
    expect(classifyPasskeyError(undefined)).toBe('failed');
    expect(classifyPasskeyError('boom')).toBe('failed');
  });
});

describe('passkeyFailureKey', () => {
  it('names one catalog key per failure', () => {
    expect(passkeyFailureKey('cancelled')).toBe('login.passkeyCancelled');
    expect(passkeyFailureKey('expired')).toBe('login.couldNotCompleteSignIn');
    expect(passkeyFailureKey('no-passkey')).toBe('login.passkeyNotFound');
    expect(passkeyFailureKey('unsupported')).toBe('login.passkeyUnsupported');
    expect(passkeyFailureKey('failed')).toBe('login.passkeyFailed');
  });
});

describe('passkeysSupported', () => {
  it('is false where the native module cannot load, without throwing', () => {
    expect(passkeysSupported()).toBe(false);
  });
});

describe('signInWithPasskey', () => {
  it('reports unsupported without a native module', async () => {
    const result = await signInWithPasskey(null);
    expect(result).toEqual({ status: 'error', failure: 'unsupported' });
    expect(mockPostAuth).not.toHaveBeenCalled();
  });

  it('reports unsupported when the platform cannot hold passkeys', async () => {
    const result = await signInWithPasskey(fakeApi(false));
    expect(result).toEqual({ status: 'error', failure: 'unsupported' });
    expect(mockPostAuth).not.toHaveBeenCalled();
  });

  it('runs options, the platform ceremony, verify, then the ticket exchange', async () => {
    const api = fakeApi();
    api.get.mockResolvedValue(assertion);
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce(ticketResponse)
      .mockResolvedValueOnce(tokenResponse);

    const result = await signInWithPasskey(api);

    expect(api.get).toHaveBeenCalledWith({ challenge: 'chal' });
    expect(mockPostAuth).toHaveBeenNthCalledWith(1, '/api/auth/passkey/authenticate', {
      action: 'options',
    });
    expect(mockPostAuth).toHaveBeenNthCalledWith(2, '/api/auth/passkey/authenticate', {
      action: 'verify',
      challengeId: 'c0000000-0000-4000-8000-000000000001',
      response: assertion,
    });
    expect(mockPostAuth).toHaveBeenNthCalledWith(3, '/api/auth/native/token', {
      provider: 'passkey',
      ticket: 'ticket-1',
      supportsRefresh: true,
    });
    expect(result).toEqual({
      status: 'ok',
      token: 'at',
      refreshToken: 'rt',
      expiresIn: 3600,
      created: false,
    });
  });

  it('carries the admission payload into the ticket exchange', async () => {
    const api = fakeApi();
    api.get.mockResolvedValue(assertion);
    const admission = {
      platform: 'ios' as const,
      kind: 'attestation' as const,
      challenge: 'c',
      payload: 'p',
    };
    vi.mocked(resolveAdmission).mockResolvedValue({ admission });
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce(ticketResponse)
      .mockResolvedValueOnce(tokenResponse);

    await signInWithPasskey(api);

    expect(mockPostAuth).toHaveBeenNthCalledWith(3, '/api/auth/native/token', {
      provider: 'passkey',
      ticket: 'ticket-1',
      supportsRefresh: true,
      admission,
    });
  });

  it('keeps a dismissed sheet retryable', async () => {
    const api = fakeApi();
    api.get.mockRejectedValue({ name: 'UserCancelledException' });
    mockPostAuth.mockResolvedValueOnce(optionsResponse);

    const result = await signInWithPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'cancelled' });
  });

  it('keeps a refused options request retryable', async () => {
    const api = fakeApi();
    mockPostAuth.mockResolvedValueOnce(refused());

    const result = await signInWithPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'cancelled' });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('treats an empty platform result as a retryable no-op', async () => {
    const api = fakeApi();
    api.get.mockResolvedValue(null);
    mockPostAuth.mockResolvedValueOnce(optionsResponse);

    const result = await signInWithPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'cancelled' });
  });

  it('names the no-passkey failure when the server knows no such credential', async () => {
    const api = fakeApi();
    api.get.mockResolvedValue(assertion);
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce(refused('UNKNOWN_CREDENTIAL'));

    const result = await signInWithPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'no-passkey' });
  });

  it('reports a refused assertion as the generic failure', async () => {
    const api = fakeApi();
    api.get.mockResolvedValue(assertion);
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce(refused('VERIFICATION_FAILED'));

    const result = await signInWithPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'failed' });
  });

  it.each(['CHALLENGE_EXPIRED', 'CHALLENGE_ALREADY_USED', 'WRONG_CHALLENGE', 'SOMETHING_NEW'])(
    'keeps the %s challenge refusal a fresh ceremony resolves retryable',
    async errorCode => {
      const api = fakeApi();
      api.get.mockResolvedValue(assertion);
      mockPostAuth.mockReset();
      mockPostAuth.mockResolvedValueOnce(optionsResponse).mockResolvedValueOnce(refused(errorCode));

      const result = await signInWithPasskey(api);

      expect(result).toEqual({ status: 'error', failure: 'expired' });
    }
  );

  it('reports a malformed options response as the generic failure', async () => {
    const api = fakeApi();
    mockPostAuth.mockResolvedValueOnce({ ok: true, data: { options: { challenge: 'chal' } } });

    const result = await signInWithPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'failed' });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('hands a refused token exchange its server code', async () => {
    const api = fakeApi();
    api.get.mockResolvedValue(assertion);
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce(ticketResponse)
      .mockResolvedValueOnce(refused('BLOCKED'));

    const result = await signInWithPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'failed', errorCode: 'BLOCKED' });
  });

  it('carries the SSO organization a refused token exchange names', async () => {
    const api = fakeApi();
    api.get.mockResolvedValue(assertion);
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce(ticketResponse)
      .mockResolvedValueOnce({
        ok: false as const,
        errorCode: 'SSO_ERROR',
        ssoOrganizationId: 'org_1',
      });

    const result = await signInWithPasskey(api);

    expect(result).toEqual({
      status: 'error',
      failure: 'failed',
      errorCode: 'SSO_ERROR',
      ssoOrganizationId: 'org_1',
    });
  });

  it('marks a failed admission as already reported', async () => {
    const api = fakeApi();
    api.get.mockResolvedValue(assertion);
    vi.mocked(resolveAdmission).mockRejectedValue(new Error('admission_challenge_failed'));
    mockPostAuth.mockResolvedValueOnce(optionsResponse).mockResolvedValueOnce(ticketResponse);

    const result = await signInWithPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'cancelled', reported: true });
    expect(mockPostAuth).toHaveBeenCalledTimes(2);
  });

  it('reports a token response without a token as the generic failure', async () => {
    const api = fakeApi();
    api.get.mockResolvedValue(assertion);
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce(ticketResponse)
      .mockResolvedValueOnce({ ok: true, data: {} });

    const result = await signInWithPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'failed' });
  });
});

describe('registerPasskey', () => {
  it('reports unsupported without a native module instead of throwing', async () => {
    const result = await registerPasskey(null);
    expect(result).toEqual({ status: 'error', failure: 'unsupported' });
    expect(mockPostAuth).not.toHaveBeenCalled();
  });

  it('runs options, the platform ceremony, then verify with the session token', async () => {
    const api = fakeApi();
    api.create.mockResolvedValue(attestation);
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce({ ok: true, data: { credentialId: 'cred-2' } });

    const result = await registerPasskey(api);

    expect(api.create).toHaveBeenCalledWith({ challenge: 'chal' });
    expect(mockPostAuth).toHaveBeenNthCalledWith(
      1,
      '/api/auth/passkey/register',
      { action: 'options' },
      { Authorization: 'Bearer session-token' }
    );
    expect(mockPostAuth).toHaveBeenNthCalledWith(
      2,
      '/api/auth/passkey/register',
      {
        action: 'verify',
        challengeId: 'c0000000-0000-4000-8000-000000000001',
        response: attestation,
      },
      { Authorization: 'Bearer session-token' }
    );
    expect(result).toEqual({ status: 'ok' });
  });

  it('reads the session token through the shared outgoing-request accessor', async () => {
    const api = fakeApi();
    api.create.mockResolvedValue(attestation);
    // The in-memory owner can be cold while the session lives only in
    // SecureStore, so the request must go through the accessor that reads it.
    vi.mocked(getAuthTokenForRequest).mockResolvedValue('stored-token');
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce({ ok: true, data: { credentialId: 'cred-2' } });

    await registerPasskey(api);

    expect(getAuthTokenForRequest).toHaveBeenCalled();
    expect(mockPostAuth).toHaveBeenNthCalledWith(
      1,
      '/api/auth/passkey/register',
      { action: 'options' },
      { Authorization: 'Bearer stored-token' }
    );
  });

  it('sends no bearer token when the request accessor has none', async () => {
    const api = fakeApi();
    api.create.mockResolvedValue(attestation);
    vi.mocked(getAuthTokenForRequest).mockResolvedValue(null);
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce({ ok: true, data: { credentialId: 'cred-2' } });

    await registerPasskey(api);

    expect(mockPostAuth).toHaveBeenNthCalledWith(
      1,
      '/api/auth/passkey/register',
      { action: 'options' },
      {}
    );
  });

  it('keeps a dismissed creation sheet retryable', async () => {
    const api = fakeApi();
    api.create.mockRejectedValue({ name: 'UserCancelledException' });
    mockPostAuth.mockResolvedValueOnce(optionsResponse);

    const result = await registerPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'cancelled' });
  });

  it('does not report a missing credential as a creation failure', async () => {
    const api = fakeApi();
    api.create.mockRejectedValue({ message: 'DomError: NotAllowedError - refused' });
    mockPostAuth.mockResolvedValueOnce(optionsResponse);

    const result = await registerPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'failed' });
  });

  it('reports a refused options request as the generic failure', async () => {
    const api = fakeApi();
    mockPostAuth.mockResolvedValueOnce(refused());

    const result = await registerPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'failed' });
    expect(api.create).not.toHaveBeenCalled();
  });

  it('reports a refused attestation as the generic failure', async () => {
    const api = fakeApi();
    api.create.mockResolvedValue(attestation);
    mockPostAuth
      .mockResolvedValueOnce(optionsResponse)
      .mockResolvedValueOnce(refused('VERIFICATION_FAILED'));

    const result = await registerPasskey(api);

    expect(result).toEqual({ status: 'error', failure: 'failed' });
  });
});
