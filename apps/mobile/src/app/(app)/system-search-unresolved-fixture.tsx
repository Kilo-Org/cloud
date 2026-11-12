import { Redirect } from 'expo-router';

import { SystemSearchUnresolvedFixture } from '@/components/system-search-unresolved-fixture';

/**
 * Development-only route for the unresolved-search-tap toast fixture: a screen
 * that raises the toast the search-tap consume shows when the phone's index
 * could not resolve the picked result. The fixture link in
 * `src/app/+native-intent.tsx` maps to it, and a release build refuses the path
 * outright so the fixture is never reachable.
 *
 * It sits in the signed-in group because that is where the toast appears: a
 * system-search tap is resolved while the reader is using the app, so the copy
 * and its retry are measured over an authenticated screen.
 */
export default function SystemSearchUnresolvedFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <SystemSearchUnresolvedFixture />;
}
