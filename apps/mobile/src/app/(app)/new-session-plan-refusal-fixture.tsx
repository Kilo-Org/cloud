import { Redirect } from 'expo-router';

import { NewSessionPlanRefusalFixture } from '@/components/agents/new-session-plan-refusal-fixture';

/**
 * Development-only route for the design gate. It opens the real new-session
 * body in the state the spawn admission sets for a lapsed organization plan:
 * the failure spot above Start carries the plan explanation and no Retry.
 * Reached through the development fixture path in
 * `src/app/+native-intent.tsx`, and refused outright in a release build so the
 * fixture is never reachable.
 */
export default function NewSessionPlanRefusalFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <NewSessionPlanRefusalFixture />;
}
