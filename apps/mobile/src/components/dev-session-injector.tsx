import { useEffect } from 'react';

import { useAuth } from '@/lib/auth/auth-context';
import { consumePendingDevSession, subscribePendingDevSession } from '@/lib/dev-session-inject';

export function DevSessionInjector() {
  const { signIn } = useAuth();

  useEffect(() => {
    const apply = (): void => {
      const credentials = consumePendingDevSession();
      if (!credentials) {
        return;
      }
      void signIn(credentials.token, credentials.refreshToken, credentials.expiresIn);
    };

    apply();
    const unsubscribe = subscribePendingDevSession(apply);
    return () => {
      unsubscribe();
    };
  }, [signIn]);

  return null;
}
