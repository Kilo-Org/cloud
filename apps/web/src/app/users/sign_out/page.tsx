'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { useState } from 'react';

import { AuthPageLayout } from '@/components/auth/AuthPageLayout';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

function safeCallbackUrl(raw: string | null): string {
  if (!raw) return '/profile';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/profile';
  return raw;
}

export default function SignOutPage() {
  const router = useRouter();
  const params = useSearchParams();
  const callbackUrl = safeCallbackUrl(params.get('callbackUrl'));
  const [submitting, setSubmitting] = useState(false);

  const handleSignOut = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await fetch('/api/auth/revoke-web-session', { method: 'POST' });
    } finally {
      await signOut({ callbackUrl });
    }
  };

  return (
    <AuthPageLayout>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign out of Kilo?</CardTitle>
          <CardDescription>
            You&apos;ll need to sign in again to access your account.
          </CardDescription>
        </CardHeader>
        <CardContent />
        <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.back()}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSignOut} disabled={submitting}>
            {submitting ? 'Signing out…' : 'Sign out'}
          </Button>
        </CardFooter>
      </Card>
    </AuthPageLayout>
  );
}