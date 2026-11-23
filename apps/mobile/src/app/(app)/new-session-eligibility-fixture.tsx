import { Redirect, useLocalSearchParams } from 'expo-router';

import {
  NewSessionEligibilityFixture,
  type NewSessionEligibilityFixtureState,
} from '@/components/agents/new-session-eligibility-fixture';

/**
 * Development-only route for the design gate: the real new-session form with
 * the Cloud Agent access notice in the state the backend answers for a balance
 * under the minimum, or the state a failed eligibility read draws.
 *
 * `?state=limited` (default) is the limited balance; `?state=unavailable` is the
 * read that failed. Reached through the development fixture path in
 * `src/app/+native-intent.tsx`, and refused outright in a release build so the
 * fixture is never reachable.
 */
export default function NewSessionEligibilityFixtureRoute() {
  const params = useLocalSearchParams<{ state?: string | string[] }>();
  const raw = Array.isArray(params.state) ? params.state[0] : params.state;
  const state: NewSessionEligibilityFixtureState = raw === 'unavailable' ? 'unavailable' : 'limited';
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <NewSessionEligibilityFixture state={state} />;
}
