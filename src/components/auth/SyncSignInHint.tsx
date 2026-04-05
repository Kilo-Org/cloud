'use client';

import { useSession } from 'next-auth/react';
import { useEffect, useRef } from 'react';
import { useSignInHint } from '@/hooks/useSignInHint';

/**
 * Automatically saves user's email to sign-in hint when authenticated.
 * This ensures returning users see their email pre-filled, even if they
 * used direct OAuth (e.g., "Continue with Google") without entering email first.
 */
export function SyncSignInHint() {
  const { data: session, status } = useSession();
  const { saveHint } = useSignInHint();
  const previousStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;

    // When user becomes authenticated, save their email
    if (status === 'authenticated' && session?.user?.email) {
      // Only update if transitioning from unauthenticated/loading to authenticated
      // to avoid redundant saves on every render
      if (previousStatus !== 'authenticated') {
        saveHint({ lastEmail: session.user.email });
      }
    }

    previousStatusRef.current = status;
  }, [session, status, saveHint]);

  return null;
}
