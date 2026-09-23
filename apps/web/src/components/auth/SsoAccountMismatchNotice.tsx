'use client';

import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buildSsoAccountSwitchHref } from '@/lib/auth/sign-in-navigation';
import type { SsoAccountMismatch } from '@/lib/auth/sso-account-mismatch';

type SsoAccountMismatchNoticeProps = {
  mismatch: SsoAccountMismatch;
  searchParams: Record<string, string>;
};

/**
 * Shown when an Enterprise SSO request asks for a different address than the
 * browser session. One action fixes it: sign out of this browser session and
 * continue to the SSO sign-in for the address the app asked for, preserving
 * the original device `callbackPath` and code. The signed-in address never
 * leaves the browser (neither a URL nor a log line).
 */
export function SsoAccountMismatchNotice({
  mismatch,
  searchParams,
}: SsoAccountMismatchNoticeProps) {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  const handleSignOutAndContinue = async () => {
    setIsSigningOut(true);
    setSignOutFailed(false);

    try {
      // Signing out and continuing is the action that fixes the mismatch, so it
      // runs in `finally` even if revoking the web session fails. A failure of
      // either call (a transient network error) must not strand the visitor on
      // a disabled "Signing out…" button, so the catch below clears the loading
      // state and shows the retryable inline error instead.
      try {
        await fetch('/api/auth/revoke-web-session', { method: 'POST' });
      } finally {
        await signOut({
          callbackUrl: buildSsoAccountSwitchHref(searchParams, mismatch.expectedEmail),
        });
      }
    } catch {
      setIsSigningOut(false);
      setSignOutFailed(true);
    }
  };

  return (
    <div
      data-account-mismatch
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className="mx-auto w-full max-w-sm text-left"
    >
      <div className="rounded-lg border-2 border-red-800 bg-red-950/30 p-4">
        <h2 className="text-base font-semibold text-red-200">Wrong account signed in</h2>
        <p className="mt-2 text-sm leading-relaxed text-red-300 wrap-anywhere">
          You are signed in as <span className="font-medium">{mismatch.signedInEmail}</span> in this
          browser, but the app asked to sign in as{' '}
          <span className="font-medium">{mismatch.expectedEmail}</span>. Continuing would approve
          the device for <span className="font-medium">{mismatch.signedInEmail}</span>, not{' '}
          <span className="font-medium">{mismatch.expectedEmail}</span>.
        </p>
        {/*
          The label names the address the app asked for, and a work address is
          long enough to wrap on a phone, so the button must take its height from
          its content instead of the fixed control height. `size={null}` drops
          that fixed height (the shared `h-control-default` is emitted after
          `h-auto` in the stylesheet, so `h-auto` cannot override it); the
          padding below restores the default control size. `wrap-anywhere` lets
          an address with no break opportunity wrap instead of overflowing.

          While signing out, the label stays in flow (invisible) so the button
          keeps its wrapped height, and the loading state is overlaid on top of
          it: a shorter loading label would collapse the card and shift the page.
        */}
        <Button
          size={null}
          className="relative mt-4 w-full px-3.5 py-2 text-center leading-snug whitespace-normal wrap-anywhere pointer-coarse:min-h-11"
          onClick={handleSignOutAndContinue}
          disabled={isSigningOut}
          aria-busy={isSigningOut || undefined}
        >
          <span className={isSigningOut ? 'invisible' : undefined}>
            {`Sign out and continue as ${mismatch.expectedEmail}`}
          </span>
          {isSigningOut && (
            <span className="absolute inset-0 flex items-center justify-center gap-2">
              <Loader2 className="animate-spin" />
              Signing out…
            </span>
          )}
        </Button>
        {/*
          The failure states what happened and what to try, and sits below the
          action so the retry button never moves. It is its own assertive alert
          rather than text inside the notice's alert region, which is atomic and
          would re-read the whole card.
        */}
        {signOutFailed && (
          <p
            data-sign-out-error
            role="alert"
            aria-atomic="true"
            className="mt-3 text-sm leading-relaxed text-red-300 wrap-anywhere"
          >
            We couldn&apos;t sign you out. Check your connection and try again.
          </p>
        )}
      </div>
    </div>
  );
}
