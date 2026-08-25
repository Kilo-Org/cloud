'use client';

import Turnstile from 'react-turnstile';
import React from 'react';
import { getProviderById } from '@/lib/auth/provider-metadata';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';

if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)
  throw new Error('NEXT_PUBLIC_TURNSTILE_SITE_KEY is missing');
const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type TurnstileViewProps = {
  turnstileError: boolean;
  isVerifying: boolean;
  isDeliveringMagicLink?: boolean;
  onSuccess: (token: string, attemptId: number) => void;
  attemptId: number;
  onError: (attemptId: number) => void;
  onRetry: () => void;
  message?: string;
  email?: string;
  pendingSignIn?: AuthProviderId | null;
  onBack?: () => void;
  backButtonText?: string;
};

type TurnstileWidgetProps = Pick<TurnstileViewProps, 'attemptId' | 'onSuccess' | 'onError'>;

/**
 * The third-party widget can report callbacks after its parent has rerendered.
 * Capture the attempt that created this particular widget rather than reading
 * a later parent prop from a replaced callback closure.
 */
function TurnstileWidget({ attemptId, onSuccess, onError }: TurnstileWidgetProps) {
  const [widgetAttemptId] = React.useState(attemptId);

  return (
    <Turnstile
      theme="dark"
      sitekey={turnstileSiteKey}
      onSuccess={token => onSuccess(token, widgetAttemptId)}
      onError={() => onError(widgetAttemptId)}
    />
  );
}

export function TurnstileView({
  turnstileError,
  isVerifying,
  isDeliveringMagicLink = false,
  attemptId,
  onSuccess,
  onError,
  onRetry,
  message,
  email,
  pendingSignIn,
  onBack,
  backButtonText,
}: TurnstileViewProps) {
  const turnstileMessage =
    message ??
    (email?.trim()
      ? `Complete this verification to continue signing in as ${email}`
      : pendingSignIn
        ? `Complete this verification to continue signing in with ${getProviderById(pendingSignIn).name}`
        : 'Complete this verification to continue');

  return (
    <div className="w-full text-center">
      <h1 className="text-foreground mb-8 text-5xl font-bold">Security Verification</h1>
      <p className="text-muted-foreground mb-8 text-xl">{turnstileMessage}</p>

      <div className="mx-auto max-w-md space-y-6">
        {turnstileError && (
          <div
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            className="mb-4 rounded-md bg-red-950 p-4 text-center text-sm text-red-300"
          >
            Security verification failed. Please try again.
          </div>
        )}

        <TurnstileWidget
          key={attemptId}
          attemptId={attemptId}
          onSuccess={onSuccess}
          onError={onError}
        />

        {isVerifying && (
          <div className="text-muted-foreground text-center text-sm" role="status">
            {isDeliveringMagicLink ? 'Sending magic link...' : 'Verifying...'}
          </div>
        )}

        {turnstileError && (
          <button
            type="button"
            onClick={onRetry}
            className="bg-primary text-primary-foreground hover:bg-primary-hover focus-visible:ring-ring mx-auto block rounded-md px-4 py-2 text-sm focus-visible:ring-[3px] focus-visible:outline-none"
          >
            Try Again
          </button>
        )}
      </div>

      {onBack && backButtonText && (
        <button
          type="button"
          onClick={onBack}
          disabled={isVerifying}
          aria-disabled={isVerifying}
          className="text-muted-foreground mt-4 min-h-11 text-sm hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          ← Back to {backButtonText}
        </button>
      )}
    </div>
  );
}
