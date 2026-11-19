import { Redirect } from 'expo-router';

import { SettingsConfirmFixture } from '@/components/settings-confirm-fixture';

/**
 * Development-only route for the destructive settings confirmation: the screen
 * that runs the agent's `settings_set` call on the trusted-host list, so the
 * confirmation can be driven and measured without a chat.
 *
 * The fixture link in `src/app/+native-intent.tsx` maps to it, and a release
 * build refuses the path outright so the fixture is never reachable. It sits
 * outside the signed-in group because the confirmation belongs to the app root,
 * above the session it interrupts, so it needs no session to show.
 */
export default function SettingsConfirmFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/(auth)/login" />;
  }
  return <SettingsConfirmFixture />;
}