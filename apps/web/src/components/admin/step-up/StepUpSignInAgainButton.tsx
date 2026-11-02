'use client';

import React from 'react';
import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';

export function stepUpReauthCallbackUrl(pathname: string): string {
  return `/users/sign_in?callbackPath=${encodeURIComponent(pathname || '/admin')}`;
}

/** Revoke every web session, then sign out this browser into a fresh sign-in. */
export async function performStepUpReauth(deps: {
  pathname: string;
  revoke: () => Promise<unknown>;
  signOut: (options: { callbackUrl: string }) => Promise<unknown>;
}): Promise<void> {
  try {
    await deps.revoke();
  } catch {
    // The sign-out below still clears this browser; the pepper rotation is
    // only needed to invalidate other sessions.
  }
  await deps.signOut({ callbackUrl: stepUpReauthCallbackUrl(deps.pathname) });
}

/**
 * MFA step-up binds to the NextAuth session that signed in. A legacy session
 * cannot gain that claim, and the sign-in page redirects already-signed-in
 * users, so the only way forward is a full sign-out and a fresh sign-in.
 *
 * Sign-out revokes every browser session for this account, not just this tab.
 */
export function StepUpSignInAgainButton({
  size = 'sm',
  className,
}: {
  size?: 'sm' | 'default';
  className?: string;
}) {
  const pathname = usePathname();
  const [isPending, setIsPending] = useState(false);

  async function handleClick() {
    if (isPending) return;
    setIsPending(true);
    try {
      await performStepUpReauth({
        pathname,
        revoke: () => fetch('/api/auth/revoke-web-session', { method: 'POST' }),
        signOut,
      });
    } catch {
      // Sign-out itself failed; leave the user on this page with a working
      // button rather than a permanently disabled one.
      setIsPending(false);
    }
  }

  return (
    <Button
      size={size}
      variant="outline"
      className={className}
      onClick={() => void handleClick()}
      disabled={isPending}
    >
      {isPending ? 'Signing out...' : 'Sign out and sign in again'}
    </Button>
  );
}
