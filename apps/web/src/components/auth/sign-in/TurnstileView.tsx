'use client';

import Turnstile from 'react-turnstile';
import { getProviderById } from '@/lib/auth/provider-metadata';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';

if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)
  throw new Error('NEXT_PUBLIC_TURNSTILE_SITE_KEY is missing');
const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type TurnstileViewProps = {
  turnstileError: boolean;
  isVerifying: boolean;
  onSuccess: (token: string) => void;
  onError: () => void;
  onRetry: () => void;
  message?: string;
  email?: string;
  pendingSignIn?: AuthProviderId | null;
  onBack?: () => void;
  backButtonText?: string;
};

export function TurnstileView({
  turnstileError,
  isVerifying,
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
          <div className="mb-4 rounded-md bg-red-950 p-4 text-center text-sm text-red-300">
            Security verification failed. Please try again.
          </div>
        )}

        <Turnstile
          theme="dark"
          sitekey={turnstileSiteKey}
          onSuccess={onSuccess}
          onError={onError}
        />

        {isVerifying && (
          <div className="text-muted-foreground text-center text-sm">Verifying...</div>
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
          className="text-muted-foreground mt-4 text-sm hover:underline"
        >
          ← Back to {backButtonText}
        </button>
      )}
    </div>
  );
}
