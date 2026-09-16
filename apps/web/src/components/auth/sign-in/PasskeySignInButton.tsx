'use client';

import { KeyRound } from 'lucide-react';
import React from 'react';

import { SignInButton } from '@/components/auth/SigninButton';
import { usePasskeySignIn, type PasskeySignInFailure } from '@/hooks/usePasskeySignIn';

/**
 * What the user is told after the ceremony did not sign them in. A retryable
 * refusal invites the same button again; a non-retryable one names the way out
 * (the other sign-in methods, which stay on screen) and is never given a retry
 * control of its own.
 */
const FAILURE_MESSAGES: Record<PasskeySignInFailure, string> = {
  cancelled: 'Sign-in was cancelled or could not start. Try again.',
  no_passkey:
    'No passkey was found on this device. Sign in another way, then add one from Connected Accounts.',
  failed: 'That passkey could not sign you in. Use another sign-in method.',
};

type PasskeySignInButtonProps = {
  /** Where the other providers land; the passkey path uses the same destination. */
  callbackUrl?: string;
};

/**
 * "Sign in with a passkey", offered beside the existing providers.
 *
 * Not rendered at all when the browser has no credential API, and replaced by
 * its message (without the button) once the device has no usable passkey, so
 * neither case leaves a control that can only ever fail.
 */
export function PasskeySignInButton({ callbackUrl }: PasskeySignInButtonProps) {
  const { isSupported, isPending, failure, signInWithPasskey } = usePasskeySignIn({ callbackUrl });

  // Empty state: no `window.PublicKeyCredential`, so no dead control appears.
  if (!isSupported) return null;

  const isRetryable = failure === null || failure === 'cancelled';

  return (
    <div className="space-y-2">
      {isRetryable && (
        <SignInButton onClick={() => void signInWithPasskey()} disabled={isPending}>
          <KeyRound />
          {isPending ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </SignInButton>
      )}
      {failure && (
        <p role="alert" className="text-muted-foreground text-sm leading-relaxed">
          {FAILURE_MESSAGES[failure]}
        </p>
      )}
    </div>
  );
}
