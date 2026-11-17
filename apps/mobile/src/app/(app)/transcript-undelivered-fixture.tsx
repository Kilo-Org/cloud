import { Redirect } from 'expo-router';

import { TranscriptStyleFixture } from '@/components/agents/transcript-style-fixture';

/**
 * Development-only route for the design gate: the question the transport gave
 * up on, so it never reached the agent. The asked question is the row that
 * carries the failure, and it holds the same state the SDK hands it after
 * several delivery attempts. The development fixture path in
 * `src/app/+native-intent.tsx` maps to it, and a release build refuses the
 * path outright so the fixture is never reachable.
 */
export default function TranscriptUndeliveredFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <TranscriptStyleFixture failure="undelivered" />;
}
