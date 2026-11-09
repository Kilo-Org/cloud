import { Redirect } from 'expo-router';

import { SystemSearchUnresolvedFixture } from '@/components/system-search-unresolved-fixture';

/**
 * Development-only route for the unresolved-search-tap toast fixture: a screen
 * that raises the toast the search-tap consume shows when the phone's index
 * could not resolve the picked result. The fixture link in
 * `src/lib/system-search-unresolved-fixture-route.ts` maps to it through
 * `src/app/+native-intent.tsx`, and a release build refuses the path outright so
 * the fixture is never reachable.
 */
export default function SystemSearchUnresolvedFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/(auth)/login" />;
  }
  return <SystemSearchUnresolvedFixture />;
}
