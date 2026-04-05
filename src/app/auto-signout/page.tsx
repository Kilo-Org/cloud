'use client';

import { signOut } from 'next-auth/react';
import { notFound } from 'next/navigation';
import { useEffect } from 'react';

export default function AutoSignOutPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound();
  }

  useEffect(() => {
    void signOut({ callbackUrl: '/profile' });
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <p>Signing out...</p>
      </div>
    </div>
  );
}
