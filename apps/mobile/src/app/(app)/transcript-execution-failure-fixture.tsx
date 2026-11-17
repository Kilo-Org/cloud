import { Redirect } from 'expo-router';

import { TranscriptStyleFixture } from '@/components/agents/transcript-style-fixture';

/**
 * Development-only route for the design gate: the same transcript as the
 * failure fixture, with a question whose answer failed instead of a failed
 * assistant row. The asked question is the row that carries the failure, and it
 * holds the same state the chat screen hands it: the agent could not run it, so
 * the failure belongs to the response. The development fixture path in
 * `src/app/+native-intent.tsx` maps to it, and a release build refuses the
 * path outright so the fixture is never reachable.
 */
export default function TranscriptExecutionFailureFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <TranscriptStyleFixture failure="execution" />;
}
