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
  expired: 'That sign-in attempt expired. Try again.',
  no_passkey:
    'No passkey was found on this device. Sign in another way, then add one from Connected Accounts.',
  failed: 'That passkey could not sign you in. Use another sign-in method.',
};

/**
 * The failures the same button can resolve. `cancelled` and `expired` are both
 * fixed by starting a fresh ceremony; the other two name a passkey this device
 * cannot use, so offering the button again would only fail the same way.
 */
const RETRYABLE_FAILURES = new Set<PasskeySignInFailure>(['cancelled', 'expired']);

type PasskeySignInButtonProps = {
  /** Where the other providers land; the passkey path uses the same destination. */
  callbackUrl?: string;
};

/**
 * "Sign in with a passkey", offered beside the existing providers.
 *
 * While the client has not yet read the browser's credential API the control's
 * final height is unknown, so its slot is reserved at the button's `h-10`
 * height (growing to the 44px touch target with the button on a coarse
 * pointer); resolving support then swaps in the button (or, with no credential
 * API, nothing) without moving the providers below it.
 *
 * Not rendered at all when the browser has no credential API, and replaced by
 * its message (without the button) once the device has no usable passkey, so
 * neither case leaves a control that can only ever fail.
 */
export function PasskeySignInButton({ callbackUrl }: PasskeySignInButtonProps) {
  const { isSupported, isPending, failure, signInWithPasskey } = usePasskeySignIn({ callbackUrl });

  // Loading state: reserved slot, same height as the button it may become.
  if (isSupported === null)
    return <div aria-hidden className="h-10 w-full pointer-coarse:min-h-11" />;

  // Empty state: no `window.PublicKeyCredential`, so no dead control appears.
  if (!isSupported) return null;

  const isRetryable = failure === null || RETRYABLE_FAILURES.has(failure);

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
