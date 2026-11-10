'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { signIn, signOut } from 'next-auth/react';
import * as z from 'zod';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { AuthProviderIdSchema, getProviderById } from '@/lib/auth/provider-metadata';
import { SignInButton } from '@/components/auth/SigninButton';
import { PasskeySignInButton } from '@/components/auth/sign-in/PasskeySignInButton';
import { TurnstileView } from '@/components/auth/sign-in/TurnstileView';

const COMPLETE_URL = '/api/auth/pending-link/complete';

const summarySchema = z.object({
  provider: AuthProviderIdSchema,
  email: z.string(),
  displayName: z.string().nullable(),
  accountEmail: z.string(),
  kind: z.enum(['existing_account', 'explicit_link']),
  methods: z.array(AuthProviderIdSchema),
  emailCode: z.boolean(),
  expiresAt: z.string(),
});

const verifyResponseSchema = z.object({
  token: z.string(),
  callbackUrl: z.string(),
});

const completeResponseSchema = z.object({
  redirectTo: z.string(),
});

const TERMINAL_ERRORS = ['ACCOUNT-ALREADY-LINKED', 'PROVIDER-ALREADY-LINKED'] as const;
type TerminalError = (typeof TERMINAL_ERRORS)[number];

function isTerminalError(error: string | undefined): error is TerminalError {
  return TERMINAL_ERRORS.some(code => code === error);
}

/** The message shown for each error code the pending-link routes return. */
export function pendingLinkErrorMessage(error: string): string {
  switch (error) {
    case 'SESSION_REQUIRED':
      return 'Sign in first, then come back to finish adding this method.';
    case 'WRONG_ACCOUNT':
      return 'You signed in with a different account.';
    case 'LINKING-FAILED':
      return 'The sign-in method could not be added. Try again.';
    case 'ACCOUNT-ALREADY-LINKED':
      return 'This account is already linked to another user.';
    case 'PROVIDER-ALREADY-LINKED':
      return 'This account already has this type of sign-in method linked.';
    case 'EXPIRED':
      return 'This request has expired. Start again from sign-in.';
    case 'CODE_NOT_REQUESTED':
      return 'Request a code first, then enter it here.';
    case 'CODE_IN_PROGRESS':
      return 'This code is being verified. Wait a moment and try again.';
    case 'INVALID_CODE':
      return 'That code is not correct. Try again.';
    case 'TOO_MANY_ATTEMPTS':
      return 'Too many incorrect codes. Request a new code.';
    case 'TOO_MANY_CODES':
      return 'No more codes can be sent for this request. Sign in with an existing method, or start again.';
    case 'RATE_LIMITED':
      return 'Too many codes requested. Wait a few minutes and try again.';
    case 'EMAIL_CODE_NOT_ALLOWED':
      return 'A code cannot be sent for this account. Sign in with an existing method.';
    case 'EMAIL_DELIVERY_FAILED':
      return 'The code could not be sent. Try again.';
    case 'BLOCKED':
      return 'This account cannot sign in.';
    case 'INVALID_ORIGIN':
      return 'This confirmation could not be verified. Try again from this page.';
    default:
      return 'Something went wrong. Try again.';
  }
}

const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  attemptsLeft: z.number().optional(),
});

type Summary = z.infer<typeof summarySchema>;
type ViewState =
  | { kind: 'loading' }
  | { kind: 'expired' }
  | { kind: 'ready'; summary: Summary }
  | { kind: 'load-error' };

export function PendingLinkForm({
  initialError,
  confirm = false,
}: {
  initialError?: string;
  confirm?: boolean;
}) {
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [codeCapReached, setCodeCapReached] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(initialError ?? null);
  const [terminalError, setTerminalError] = useState<TerminalError | null>(
    isTerminalError(initialError) ? initialError : null
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [retryableError, setRetryableError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<AuthProviderId | null>(null);
  const [turnstileAttemptId, setTurnstileAttemptId] = useState(0);
  const [turnstileError, setTurnstileError] = useState(false);

  const load = useCallback(async () => {
    setView({ kind: 'loading' });
    try {
      const response = await fetch('/api/auth/pending-link');
      if (response.status === 404) {
        setView({ kind: 'expired' });
        return;
      }
      if (!response.ok) {
        setView({ kind: 'load-error' });
        return;
      }
      const parsed = summarySchema.safeParse(await response.json());
      if (!parsed.success || new Date(parsed.data.expiresAt).getTime() <= Date.now()) {
        setView(parsed.success ? { kind: 'expired' } : { kind: 'load-error' });
        return;
      }
      setView({ kind: 'ready', summary: parsed.data });
    } catch {
      setView({ kind: 'load-error' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendCode = useCallback(async () => {
    setBusy(true);
    setRetryableError(null);
    try {
      const response = await fetch('/api/auth/pending-link/email-code', { method: 'POST' });
      if (response.ok) {
        setCodeSent(true);
        setNotice('A code was sent to your account email address.');
        return;
      }
      const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
      const error = parsed.success ? parsed.data.error : 'UNKNOWN';
      if (error === 'EXPIRED') {
        setView({ kind: 'expired' });
      } else if (error === 'TOO_MANY_CODES') {
        setCodeCapReached(true);
        setRetryableError(pendingLinkErrorMessage(error));
      } else if (isTerminalError(error)) {
        setTerminalError(error);
      } else {
        setRetryableError(pendingLinkErrorMessage(error));
      }
    } catch {
      setRetryableError('The code could not be sent. Try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  const verifyCode = useCallback(async () => {
    setBusy(true);
    setRetryableError(null);
    try {
      const response = await fetch('/api/auth/pending-link/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (response.ok) {
        const parsed = verifyResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          setRetryableError('Sign-in could not be completed. Try again.');
          return;
        }
        await signIn('email', {
          token: parsed.data.token,
          callbackUrl: parsed.data.callbackUrl,
          redirect: true,
        });
        return;
      }
      const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
      const error = parsed.success ? parsed.data.error : 'UNKNOWN';
      if (error === 'EXPIRED') {
        setView({ kind: 'expired' });
      } else if (error === 'CODE_NOT_REQUESTED') {
        setCodeSent(false);
        setRetryableError(pendingLinkErrorMessage(error));
      } else if (error === 'INVALID_CODE') {
        const left = parsed.success ? parsed.data.attemptsLeft : undefined;
        setRetryableError(
          left !== undefined
            ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`
            : pendingLinkErrorMessage(error)
        );
      } else if (error === 'TOO_MANY_ATTEMPTS') {
        setRetryableError(pendingLinkErrorMessage(error));
        setCodeSent(false);
      } else if (isTerminalError(error)) {
        setTerminalError(error);
      } else if (error === 'WRONG_ACCOUNT') {
        setBannerError(error);
      } else {
        setRetryableError(pendingLinkErrorMessage(error));
      }
    } catch {
      setRetryableError('The code could not be verified. Try again.');
    } finally {
      setBusy(false);
    }
  }, [code]);

  const confirmComplete = useCallback(async () => {
    setBusy(true);
    setRetryableError(null);
    try {
      const response = await fetch(COMPLETE_URL, { method: 'POST' });
      if (response.ok) {
        const parsed = completeResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          setRetryableError(pendingLinkErrorMessage('LINKING-FAILED'));
          return;
        }
        window.location.assign(parsed.data.redirectTo);
        return;
      }
      const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
      const error = parsed.success ? parsed.data.error : 'UNKNOWN';
      if (error === 'EXPIRED') {
        setView({ kind: 'expired' });
      } else if (isTerminalError(error)) {
        setTerminalError(error);
      } else if (error === 'WRONG_ACCOUNT' || error === 'SESSION_REQUIRED') {
        setBannerError(error);
      } else {
        setRetryableError(pendingLinkErrorMessage(error));
      }
    } catch {
      setRetryableError(pendingLinkErrorMessage('LINKING-FAILED'));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleTurnstileSuccess = useCallback(
    async (token: string) => {
      if (!pendingProvider) return;
      setBusy(true);
      try {
        const verifyResponse = await fetch('/api/auth/verify-turnstile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const verifyResult = z
          .object({ success: z.boolean() })
          .safeParse(await verifyResponse.json().catch(() => null));
        if (!verifyResponse.ok || !verifyResult.success || !verifyResult.data.success) {
          setTurnstileError(true);
          return;
        }
        await signIn(pendingProvider, { callbackUrl: COMPLETE_URL });
      } catch {
        setTurnstileError(true);
      } finally {
        setBusy(false);
      }
    },
    [pendingProvider]
  );

  if (pendingProvider) {
    return (
      <TurnstileView
        turnstileError={turnstileError}
        isVerifying={busy}
        attemptId={turnstileAttemptId}
        onSuccess={token => void handleTurnstileSuccess(token)}
        onError={() => setTurnstileError(true)}
        onRetry={() => {
          setTurnstileError(false);
          setTurnstileAttemptId(id => id + 1);
        }}
        pendingSignIn={pendingProvider}
        onBack={() => setPendingProvider(null)}
        backButtonText="account linking"
      />
    );
  }

  if (view.kind === 'loading') {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Loading...
      </p>
    );
  }

  if (view.kind === 'expired') {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-foreground mb-4 text-2xl font-semibold">This request has expired</h1>
        <p className="text-muted-foreground mb-8 text-sm">
          The request to add a sign-in method is no longer valid. Start again from sign-in.
        </p>
        <Link
          href="/users/sign_in"
          className="bg-primary text-primary-foreground hover:bg-primary-hover focus-visible:ring-ring inline-block rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11 pointer-coarse:content-center"
        >
          Start again
        </Link>
      </div>
    );
  }

  if (view.kind === 'load-error') {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-foreground mb-4 text-2xl font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground mb-8 text-sm">
          The request could not be loaded. Try again.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="bg-primary text-primary-foreground hover:bg-primary-hover focus-visible:ring-ring rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11"
        >
          Try again
        </button>
      </div>
    );
  }

  if (terminalError) {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-foreground mb-4 text-2xl font-semibold">This method cannot be added</h1>
        <p role="alert" className="mb-8 rounded-md bg-red-950 p-4 text-sm text-red-300">
          {pendingLinkErrorMessage(terminalError)}
        </p>
        <div className="flex flex-col gap-3">
          <Link
            href="/connected-accounts"
            className="bg-primary text-primary-foreground hover:bg-primary-hover focus-visible:ring-ring inline-block rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11 pointer-coarse:content-center"
          >
            Back to Connected accounts
          </Link>
          <Link
            href="/users/sign_in"
            className="text-muted-foreground text-sm underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center pointer-coarse:justify-center"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  const { summary } = view;
  const providerName = getProviderById(summary.provider).name;
  const identityLabel = summary.displayName || summary.email;
  const oauthMethods = summary.methods.filter(
    method => method !== 'email' && method !== 'passkey' && method !== 'fake-login'
  );
  const hasPasskey = summary.methods.includes('passkey');
  const hasPageOnlyMethod =
    summary.methods.includes('fake-login') ||
    (summary.methods.includes('email') && !summary.emailCode);

  const wrongAccountBanner = bannerError === 'WRONG_ACCOUNT' && (
    <div role="alert" className="mb-6 rounded-md bg-red-950 p-4 text-sm text-red-300">
      <p className="mb-3">
        You signed in with a different account. Sign out, then sign in with the account that uses{' '}
        {summary.accountEmail}.
      </p>
      <button
        type="button"
        onClick={() => void signOut({ callbackUrl: '/users/pending-link' })}
        className="underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
      >
        Sign out and retry
      </button>
    </div>
  );
  const sessionRequiredBanner = bannerError === 'SESSION_REQUIRED' && (
    <div role="alert" className="mb-6 rounded-md bg-red-950 p-4 text-sm text-red-300">
      <p className="mb-3">{pendingLinkErrorMessage('SESSION_REQUIRED')}</p>
      <Link
        href="/users/sign_in"
        className="underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
      >
        Go to sign in
      </Link>
    </div>
  );

  if (confirm) {
    return (
      <div className="w-full max-w-sm">
        <h1 className="text-foreground mb-4 text-center text-2xl font-semibold">
          Add {providerName} to your account
        </h1>
        <p className="text-muted-foreground mb-8 text-center text-sm">
          Add {providerName} ({identityLabel}) to {summary.accountEmail}?
        </p>
        {wrongAccountBanner}
        {sessionRequiredBanner}
        {retryableError && (
          <p role="alert" className="mb-6 rounded-md bg-red-950 p-4 text-sm text-red-300">
            {retryableError}
          </p>
        )}
        <div className="flex flex-col gap-3">
          <SignInButton onClick={() => void confirmComplete()} disabled={busy}>
            Add {providerName}
          </SignInButton>
          <Link
            href={summary.kind === 'explicit_link' ? '/connected-accounts' : '/users/pending-link'}
            className="text-muted-foreground text-center text-sm underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center pointer-coarse:justify-center"
          >
            Not now
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-foreground mb-4 text-center text-2xl font-semibold">
        Add {providerName} to your account
      </h1>
      <p className="text-muted-foreground mb-8 text-center text-sm">
        {summary.kind === 'explicit_link'
          ? `Finish adding ${providerName} (${identityLabel}) as a sign-in method for ${summary.accountEmail}.`
          : `An account already uses ${summary.accountEmail}. Prove the account is yours and ${providerName} is added as a sign-in method.`}
      </p>

      {wrongAccountBanner}
      {sessionRequiredBanner}
      {bannerError &&
        bannerError !== 'WRONG_ACCOUNT' &&
        bannerError !== 'SESSION_REQUIRED' &&
        bannerError !== 'EXPIRED' &&
        !isTerminalError(bannerError) && (
          <p role="alert" className="mb-6 rounded-md bg-red-950 p-4 text-sm text-red-300">
            {pendingLinkErrorMessage(bannerError)}
          </p>
        )}
      {notice && (
        <p className="mb-6 rounded-md bg-emerald-950 p-4 text-sm text-emerald-300" role="status">
          {notice}
        </p>
      )}
      {retryableError && (
        <p role="alert" className="mb-6 rounded-md bg-red-950 p-4 text-sm text-red-300">
          {retryableError}
        </p>
      )}

      {summary.emailCode && (
        <div className="mb-8 space-y-3">
          {!codeSent ? (
            !codeCapReached && (
              <SignInButton onClick={() => void sendCode()} disabled={busy}>
                Email me a code
              </SignInButton>
            )
          ) : (
            <>
              <label className="text-foreground block text-sm font-medium" htmlFor="pending-code">
                Enter the 6-digit code
              </label>
              <input
                id="pending-code"
                value={code}
                onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                className="bg-card text-foreground border-border focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-center tracking-widest focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11"
              />
              <SignInButton onClick={() => void verifyCode()} disabled={busy || code.length !== 6}>
                Verify and add {providerName}
              </SignInButton>
              {!codeCapReached && (
                <button
                  type="button"
                  onClick={() => void sendCode()}
                  disabled={busy}
                  className="text-muted-foreground mx-auto block text-sm underline pointer-coarse:min-h-11"
                >
                  Send a new code
                </button>
              )}
            </>
          )}
        </div>
      )}

      {(oauthMethods.length > 0 || hasPasskey || hasPageOnlyMethod) && (
        <div className="space-y-3">
          <p className="text-muted-foreground text-center text-sm">
            Or sign in with a method this account already has
          </p>
          {oauthMethods.map(method => {
            const metadata = getProviderById(method);
            return (
              <SignInButton
                key={method}
                onClick={() => {
                  setTurnstileError(false);
                  setTurnstileAttemptId(id => id + 1);
                  setPendingProvider(method);
                }}
              >
                {metadata.icon}
                Continue with {metadata.name}
              </SignInButton>
            );
          })}
          {hasPasskey && <PasskeySignInButton callbackUrl={COMPLETE_URL} />}
          {hasPageOnlyMethod && (
            <Link
              href={`/users/sign_in?callbackPath=${encodeURIComponent(COMPLETE_URL)}`}
              className="text-muted-foreground block text-center text-sm underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              Continue on the sign-in page
            </Link>
          )}
        </div>
      )}

      {!summary.emailCode && summary.methods.length === 0 && (
        <p role="alert" className="rounded-md bg-red-950 p-4 text-sm text-red-300">
          No sign-in method is available to prove this account. Contact support for help.
        </p>
      )}
    </div>
  );
}
