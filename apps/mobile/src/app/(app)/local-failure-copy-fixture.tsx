import { Redirect, useLocalSearchParams } from 'expo-router';

import {
  isLocalFailureCopyState,
  LocalFailureCopyFixture,
  type LocalFailureCopyState,
} from '@/lib/chat/local-failure-copy-fixture';

/**
 * Development-only route for the design gate: the chat screen's own failure row
 * for every stable on-device refusal reason, so the copy is measured on a
 * device that refuses nothing. The development fixture path in
 * `src/app/+native-intent.tsx` maps to it and names the state, and a release
 * build refuses the path outright so the fixture is never reachable.
 */
export default function LocalFailureCopyFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  const fixtureState: LocalFailureCopyState = isLocalFailureCopyState(state) ? state : 'all';
  return <LocalFailureCopyFixture state={fixtureState} />;
}
