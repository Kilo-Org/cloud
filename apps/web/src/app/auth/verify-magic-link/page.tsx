'use client';

import { useCallback, useEffect, useRef, useState, Suspense } from 'react';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';

function VerifyMagicLinkContent() {
  const searchParams = useSearchParams();
  const [hasFailed, setHasFailed] = useState(false);
  const started = useRef(false);
  const credentials = useRef<{ token: string; callbackUrl: string } | null>(null);
  const exchangePending = useRef(false);

  const exchange = useCallback(async () => {
    if (!credentials.current || exchangePending.current) return;
    exchangePending.current = true;
    setHasFailed(false);

    try {
      await signIn('email', { ...credentials.current, redirect: true });
      credentials.current = null;
    } catch {
      setHasFailed(true);
    } finally {
      exchangePending.current = false;
    }
  }, []);

  useEffect(() => {
    if (!searchParams || started.current) return;
    started.current = true;

    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const token = fragment.get('token') || url.searchParams.get('token');
    const callbackUrl = url.searchParams.get('callbackUrl') || '/users/after-sign-in';

    if (!token) {
      window.location.href = '/users/sign_in?error=INVALID_VERIFICATION';
      return;
    }

    url.searchParams.delete('token');
    url.hash = '';
    window.history.replaceState(window.history.state, '', url);

    credentials.current = { token, callbackUrl };
    void exchange();
  }, [exchange, searchParams]);

  if (hasFailed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <div className="flex flex-col items-center gap-3 text-center">
          <div role="alert" className="rounded-md bg-red-950 p-4 text-red-300">
            Sign-in failed. You can retry or reopen the link in your email.
          </div>
          <Button type="button" onClick={() => void exchange()}>
            Retry sign-in
          </Button>
          <Link href="/users/sign_in" className="text-muted-foreground text-sm hover:underline">
            ← Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-black">
      <div className="text-center">
        <div className="mx-auto mb-6 h-12 w-12 animate-spin rounded-full border-4 border-gray-800 border-t-white"></div>
        <p className="text-muted-foreground">Signing you in...</p>
      </div>
    </div>
  );
}

export default function VerifyMagicLinkPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-black">
          <div className="text-center">
            <div className="mx-auto mb-6 h-12 w-12 animate-spin rounded-full border-4 border-gray-800 border-t-white"></div>
            <p className="text-muted-foreground">Loading...</p>
          </div>
        </div>
      }
    >
      <VerifyMagicLinkContent />
    </Suspense>
  );
}
