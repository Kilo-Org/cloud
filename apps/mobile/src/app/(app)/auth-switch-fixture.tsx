import { Redirect } from 'expo-router';

import { LoginScreen } from '@/components/login-screen';

/**
 * Dev-only auth-transition fixture: it mounts the real sign-in screen inside the
 * signed-in app, so a sign-in can be exercised on a device while an account is
 * already active. Every provider publishes through the same `signIn` the login
 * route uses, so the fixture adds no auth code of its own.
 *
 * The only entry point is `+native-intent.tsx` (`dev/auth-switch-fixture`),
 * behind `__DEV__`.
 */
export default function AuthSwitchFixtureRoute() {
  return __DEV__ ? <LoginScreen /> : <Redirect href="/(app)" />;
}