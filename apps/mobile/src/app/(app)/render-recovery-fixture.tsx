import { Redirect } from 'expo-router';

import { RenderRecoveryFixture } from '@/components/render-recovery-fixture';

/**
 * Development-only route for the render-recovery fixture: a real authenticated
 * screen that the harness can make throw, so the authenticated stack's screen
 * recovery is exercised on a build. The fixture links in
 * `src/lib/render-recovery-fixture.ts` map to it through
 * `src/app/+native-intent.tsx`, and a release build refuses the path outright so
 * the fixture is never reachable.
 */
export default function RenderRecoveryFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <RenderRecoveryFixture />;
}
