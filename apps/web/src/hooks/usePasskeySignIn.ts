'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { signIn } from 'next-auth/react';

import getSignInCallbackUrl from '@/lib/getSignInCallbackUrl';

/** The one route that mints options and verifies the assertion, both server-side. */
const AUTHENTICATE_ROUTE = '/api/auth/passkey/authenticate';

/**
 * Why a passkey sign-in attempt did not produce a session.
 *
 * - `cancelled`: the ceremony did not finish (the user dismissed the sheet, the
 *   browser timed out, or a request never reached the server). The same button
 *   is a working retry.
 * - `expired`: the server refused the assertion for a reason a fresh ceremony
 *   resolves — the challenge expired, was already used, or did not match — or
 *   the verify response was not one this client recognizes. Retrying mints a
 *   new challenge, so the same button keeps working.
 * - `no_passkey`: the server refused the assertion because no passkey for this
 *   relying party belongs to the credential the authenticator offered. Retrying
 *   the same device cannot help; the other sign-in methods are the way out.
 * - `failed`: the assertion named a known passkey and the signature did not
 *   verify against it. Retrying the same passkey cannot help either.
 *
 * A retryable failure must never be reported as a non-retryable one, and the
 * other way round: `cancelled` and `expired` keep the button available for
 * another try, `no_passkey` and `failed` do not.
 */
export type PasskeySignInFailure = 'cancelled' | 'expired' | 'no_passkey' | 'failed';

export class PasskeySignInError extends Error {
  readonly failure: PasskeySignInFailure;

  constructor(failure: PasskeySignInFailure) {
    super(failure);
    this.name = 'PasskeySignInError';
    this.failure = failure;
  }
}

type AuthenticationOptionsResponse = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

async function requestAuthenticationOptions(): Promise<AuthenticationOptionsResponse> {
  const response = await fetch(AUTHENTICATE_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'options' }),
  });
  if (!response.ok) {
    // Minting options needs no user interaction, so a refusal here (network,
    // 5xx) is retryable: the browser sheet never opened.
    throw new PasskeySignInError('cancelled');
  }

  const body = (await response.json()) as { challengeId?: unknown; options?: unknown };
  if (typeof body.challengeId !== 'string' || !body.options) {
    throw new PasskeySignInError('cancelled');
  }
  return {
    challengeId: body.challengeId,
    options: body.options as PublicKeyCredentialRequestOptionsJSON,
  };
}

/**
 * Run one usernameless passkey sign-in: ask the server for options, let the
 * browser's credential API produce the assertion, hand the assertion back for
 * server-side verification, then exchange the one-time ticket for a session with
 * `signIn('passkey', …)` — the same call the other providers use, so the user
 * lands on the same `callbackUrl`.
 *
 * Exported without React state so the sequence, and every refusal it can map,
 * is unit-testable outside a browser.
 */
export async function runPasskeySignIn(callbackUrl: string): Promise<void> {
  try {
    const { challengeId, options } = await requestAuthenticationOptions();

    let assertion: AuthenticationResponseJSON;
    try {
      assertion = await startAuthentication({ optionsJSON: options });
    } catch {
      // The browser raises the same `NotAllowedError` for a dismissed sheet, a
      // timeout, and a device that holds no passkey for this relying party, so
      // the client cannot separate those cases. They all leave the button
      // usable, which is why they share the retryable message.
      throw new PasskeySignInError('cancelled');
    }

    const verifyResponse = await fetch(AUTHENTICATE_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify', challengeId, response: assertion }),
    });

    if (!verifyResponse.ok) {
      const body = (await verifyResponse.json().catch(() => undefined)) as
        | { error?: unknown }
        | undefined;
      // The assertion named a credential the relying party has no passkey for:
      // this device cannot sign in, however many times it is tapped.
      if (body?.error === 'UNKNOWN_CREDENTIAL') {
        throw new PasskeySignInError('no_passkey');
      }
      // A known passkey whose signature did not verify cannot be retried into a
      // success on the same device.
      if (body?.error === 'VERIFICATION_FAILED') {
        throw new PasskeySignInError('failed');
      }
      // Everything else — an expired, replayed or mismatched challenge, and any
      // refusal this client does not recognize — is resolved by a fresh
      // ceremony, so the same button stays a working retry.
      throw new PasskeySignInError('expired');
    }

    const { ticket } = (await verifyResponse.json()) as { ticket?: unknown };
    if (typeof ticket !== 'string') {
      // A 2xx without a ticket refused nothing about the credential, so a new
      // attempt can still succeed.
      throw new PasskeySignInError('expired');
    }

    await signIn('passkey', { ticket, callbackUrl });
  } catch (error) {
    if (error instanceof PasskeySignInError) {
      throw error;
    }
    // A transport failure while verifying is as retryable as one while asking
    // for options.
    throw new PasskeySignInError('cancelled');
  }
}

export type UsePasskeySignInOptions = {
  /** Where the other providers land after sign-in. Defaults to the standard flow. */
  callbackUrl?: string;
};

export type UsePasskeySignInResult = {
  /**
   * Whether the browser exposes the credential API. `null` before the client
   * has read the global — the server render and the first client render cannot
   * know it — `false` when `window.PublicKeyCredential` is absent, `true` when
   * it is present. A consumer must reserve the same space in all three states
   * so resolving support never moves the content around it.
   */
  isSupported: boolean | null;
  isPending: boolean;
  failure: PasskeySignInFailure | null;
  signInWithPasskey: () => Promise<void>;
};

export function usePasskeySignIn({
  callbackUrl,
}: UsePasskeySignInOptions = {}): UsePasskeySignInResult {
  // The credential API is a browser global, so this starts unknown (`null`) and
  // is only ever `true`/`false` after the client has read the global. The
  // consumer shows a same-height placeholder while it is unknown, so
  // server-rendered HTML never contains a dead passkey control and resolving
  // support never shifts the providers below it.
  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [failure, setFailure] = useState<PasskeySignInFailure | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    setIsSupported(browserSupportsWebAuthn());
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const signInWithPasskey = useCallback(async () => {
    if (isPending) return;
    setIsPending(true);
    setFailure(null);
    try {
      await runPasskeySignIn(callbackUrl ?? getSignInCallbackUrl());
      // A success navigates away; staying pending keeps the button busy until
      // the new page renders, so there is no second tap into a stale ceremony.
    } catch (error) {
      if (!isMountedRef.current) return;
      setFailure(error instanceof PasskeySignInError ? error.failure : 'cancelled');
      setIsPending(false);
    }
  }, [callbackUrl, isPending]);

  return { isSupported, isPending, failure, signInWithPasskey };
}
