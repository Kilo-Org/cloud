/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest mocks must be registered before loading the hook. */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';

const mockStartAuthentication =
  jest.fn<(options: unknown) => Promise<AuthenticationResponseJSON>>();
const mockBrowserSupportsWebAuthn = jest.fn<() => boolean>(() => true);
const mockSignIn = jest.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => mockBrowserSupportsWebAuthn(),
  startAuthentication: (options: unknown) => mockStartAuthentication(options),
}));

jest.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

const { PasskeySignInError, runPasskeySignIn } = require('./usePasskeySignIn') as {
  PasskeySignInError: new (failure: string) => Error & { failure: string };
  runPasskeySignIn: (callbackUrl: string) => Promise<void>;
};

const ASSERTION = {
  id: 'credential-id',
  rawId: 'credential-id',
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    clientDataJSON: 'client-data',
    authenticatorData: 'authenticator-data',
    signature: 'signature',
  },
} as AuthenticationResponseJSON;

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function callBody(index: number): Record<string, unknown> {
  const call = mockFetch.mock.calls[index] as unknown as [string, { body: string }];
  return JSON.parse(call[1].body) as Record<string, unknown>;
}

beforeEach(() => {
  (globalThis as { fetch: unknown }).fetch = mockFetch;
  mockFetch.mockReset();
  mockStartAuthentication.mockReset();
  mockSignIn.mockReset();
  mockBrowserSupportsWebAuthn.mockReset();
  mockBrowserSupportsWebAuthn.mockReturnValue(true);
  mockSignIn.mockResolvedValue(undefined);
});

describe('runPasskeySignIn', () => {
  it('mints options, runs the ceremony, verifies and signs in on the callback url', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ challengeId: 'challenge-1', options: { challenge: 'a' } })
      )
      .mockResolvedValueOnce(jsonResponse({ ticket: 'ticket-1' }));
    mockStartAuthentication.mockResolvedValue(ASSERTION);

    await runPasskeySignIn('/users/after-sign-in');

    expect(callBody(0)).toEqual({ action: 'options' });
    expect(callBody(1)).toEqual({
      action: 'verify',
      challengeId: 'challenge-1',
      response: ASSERTION,
    });
    expect(mockSignIn).toHaveBeenCalledWith('passkey', {
      ticket: 'ticket-1',
      callbackUrl: '/users/after-sign-in',
    });
  });

  it('runs the ceremony with the options the server minted', async () => {
    const options = { challenge: 'server-challenge', rpId: 'localhost' };
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'challenge-1', options }))
      .mockResolvedValueOnce(jsonResponse({ ticket: 'ticket-1' }));
    mockStartAuthentication.mockResolvedValue(ASSERTION);

    await runPasskeySignIn('/next');

    expect(mockStartAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
  });

  it('reports a retryable refusal when the options request fails', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'BOOM' }, false));

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'cancelled' });
    expect(mockStartAuthentication).not.toHaveBeenCalled();
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('reports a retryable refusal when the options request cannot be sent', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('network down'));

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'cancelled' });
  });

  it('reports a retryable refusal when the user dismisses the passkey sheet', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ challengeId: 'c', options: {} }));
    mockStartAuthentication.mockRejectedValue(
      Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
    );

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'cancelled' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reports a retryable refusal when the browser aborts the ceremony', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ challengeId: 'c', options: {} }));
    mockStartAuthentication.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' })
    );

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'cancelled' });
  });

  it('reports a non-retryable refusal when no passkey exists for this device', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'c', options: {} }))
      .mockResolvedValueOnce(jsonResponse({ error: 'UNKNOWN_CREDENTIAL' }, false));
    mockStartAuthentication.mockResolvedValue(ASSERTION);

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'no_passkey' });
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('reports a non-retryable refusal when the server refuses the assertion', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'c', options: {} }))
      .mockResolvedValueOnce(jsonResponse({ error: 'VERIFICATION_FAILED' }, false));
    mockStartAuthentication.mockResolvedValue(ASSERTION);

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'failed' });
  });

  // A stale or replayed challenge is fixed by minting a fresh one, so the same
  // button is a working retry.
  it.each(['CHALLENGE_EXPIRED', 'CHALLENGE_ALREADY_USED', 'WRONG_CHALLENGE'])(
    'reports a retryable refusal when the server refuses the challenge with %s',
    async error => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ challengeId: 'c', options: {} }))
        .mockResolvedValueOnce(jsonResponse({ error }, false));
      mockStartAuthentication.mockResolvedValue(ASSERTION);

      await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'expired' });
      expect(mockSignIn).not.toHaveBeenCalled();
    }
  );

  it('reports a retryable refusal when the verify response carries an unknown error code', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'c', options: {} }))
      .mockResolvedValueOnce(jsonResponse({ error: 'SOMETHING_NEW' }, false));
    mockStartAuthentication.mockResolvedValue(ASSERTION);

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'expired' });
  });

  it('reports a retryable refusal when a non-2xx verify response carries no body', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'c', options: {} }))
      .mockResolvedValueOnce({ ok: false, json: async () => Promise.reject(new Error('no body')) });
    mockStartAuthentication.mockResolvedValue(ASSERTION);

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'expired' });
  });

  it('reports a retryable refusal when the verify request cannot be sent', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'c', options: {} }))
      .mockRejectedValueOnce(new TypeError('network down'));
    mockStartAuthentication.mockResolvedValue(ASSERTION);

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'cancelled' });
  });

  it('reports a retryable refusal when the verify response is not the expected shape', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ challengeId: 'c', options: {} }))
      .mockResolvedValueOnce(jsonResponse({}));
    mockStartAuthentication.mockResolvedValue(ASSERTION);

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'expired' });
  });

  it('reports a retryable refusal when the options payload is malformed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ options: {} }));

    await expect(runPasskeySignIn('/next')).rejects.toMatchObject({ failure: 'cancelled' });
  });

  it('tags every refusal with the passkey error type', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false));

    await expect(runPasskeySignIn('/next')).rejects.toBeInstanceOf(PasskeySignInError);
  });
});
