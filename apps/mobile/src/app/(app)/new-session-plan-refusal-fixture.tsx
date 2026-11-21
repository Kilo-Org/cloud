import { Redirect, useLocalSearchParams } from 'expo-router';

import { NewSessionPlanRefusalFixture } from '@/components/agents/new-session-plan-refusal-fixture';

/**
 * Development-only route for the design gate. It opens the real new-session
 * body in the state the spawn admission sets for a lapsed organization plan:
 * the failure spot above Start carries the plan explanation and no Retry.
 *
 * `?billing=1` paints the reader who may change the plan — the sentence that
 * offers the step plus the billing step itself — so the gate can capture both
 * readers of the same component. Reached through the development fixture path
 * in `src/app/+native-intent.tsx`, and refused outright in a release build so
 * the fixture is never reachable.
 */
export default function NewSessionPlanRefusalFixtureRoute() {
  const params = useLocalSearchParams<{ billing?: string | string[] }>();
  const billing = Array.isArray(params.billing) ? params.billing[0] : params.billing;
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <NewSessionPlanRefusalFixture canManageBilling={billing === '1'} />;
}
