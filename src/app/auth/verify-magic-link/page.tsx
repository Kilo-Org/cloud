'use client';

import { useEffect, useState, Suspense } from 'react';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';

function VerifyMagicLinkContent() {
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get('token');
    const email = searchParams.get('email');
    const callbackUrl = searchParams.get('callbackUrl') || '/users/after-sign-in';

    if (!token || !email) {
      window.location.href = '/users/sign_in?error=INVALID_VERIFICATION';
      return;
    }

    // Sign in using the email provider with the token
    signIn('email', {
      email,
      token,
      callbackUrl,
      redirect: true,
    }).catch(err => {
      console.error('Sign in error:', err);
      setError('Failed to sign in. Please try again.');
    });
  }, [searchParams]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <div className="text-center">
          <div className="mb-4 rounded-md bg-red-950 p-4 text-red-300">{error}</div>
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
