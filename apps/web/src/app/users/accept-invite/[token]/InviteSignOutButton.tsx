'use client';

import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { buildEnterpriseSsoHref, buildNormalSignInHref } from '@/lib/auth/sign-in-navigation';

type InviteSignOutButtonProps = {
  callbackPath: string;
  requireSso: boolean;
};

export function InviteSignOutButton({ callbackPath, requireSso }: InviteSignOutButtonProps) {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    setSignOutFailed(false);
    try {
      try {
        await fetch('/api/auth/revoke-web-session', { method: 'POST' });
      } finally {
        const searchParams = { callbackPath };
        await signOut({
          callbackUrl: requireSso
            ? buildEnterpriseSsoHref(searchParams)
            : buildNormalSignInHref(searchParams),
        });
      }
    } catch {
      setIsSigningOut(false);
      setSignOutFailed(true);
    }
  }

  return (
    <div className="mt-4">
      <p className="mb-3 text-sm text-red-700">This signs you out of Kilo on all browsers.</p>
      <Button onClick={handleSignOut} disabled={isSigningOut} aria-busy={isSigningOut || undefined}>
        {isSigningOut
          ? 'Signing out…'
          : requireSso
            ? 'Sign out and sign in with SSO'
            : 'Sign in with another account'}
      </Button>
      {signOutFailed && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          We couldn&apos;t sign you out. Check your connection and try again.
        </p>
      )}
    </div>
  );
}
