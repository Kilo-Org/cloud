import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { BootstrapLoadingSurface } from '@/components/bootstrap-loading-surface';
import { LoginScreen } from '@/components/login-screen';
import { useAuth } from '@/lib/auth/auth-context';
import { isLoginFixtureState, writeLoginFixture } from '@/lib/login-fixture';

/**
 * Development-only sign-in screen in one device-auth state
 * (`src/lib/login-fixture.ts`). The screen restores the resumed sign-in once,
 * on mount, so it mounts only after the record is written.
 *
 * It needs a signed-out app: the root layout sends a signed-in app out of
 * `(auth)`. The record is written only once the stored session has been read
 * and there is none, so a signed-in device never keeps a resumed sign-in that
 * its next real sign-in screen would restore.
 *
 * Link: `kiloapp:///dev/login-fixture/<pending|denied|expired|error>`, mapped in
 * `src/app/+native-intent.tsx`. A release build redirects away.
 */
export default function LoginFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  const { token, isLoading } = useAuth();
  const signedOut = !isLoading && token === undefined;
  const [written, setWritten] = useState<string | null>(null);

  useEffect(() => {
    if (__DEV__ && signedOut && state !== undefined && isLoginFixtureState(state)) {
      const write = async () => {
        // The write never rejects: a refused store write is reported and the
        // screen then restores nothing, which is its plain sign-in form.
        await writeLoginFixture(state);
        setWritten(state);
      };
      void write();
    }
  }, [signedOut, state]);

  if (!__DEV__ || state === undefined || !isLoginFixtureState(state)) {
    return <Redirect href="/(auth)/login" />;
  }
  if (written !== state) {
    return <BootstrapLoadingSurface />;
  }
  return <LoginScreen key={state} />;
}
