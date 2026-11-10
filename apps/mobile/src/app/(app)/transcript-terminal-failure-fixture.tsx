import { Redirect } from 'expo-router';

import { TranscriptStyleFixture } from '@/components/agents/transcript-style-fixture';

/**
 * Development-only route for the design gate: the same transcript as the
 * failure fixture, with the failed turn the gateway marked terminal
 * (`isRetryable: false`). It measures the row a non-retryable refusal draws —
 * the explanation and no resend — beside the retryable row, on the plain
 * screen. The development fixture path in `src/app/+native-intent.tsx` maps to
 * it, and a release build refuses the path outright so the fixture is never
 * reachable.
 */
export default function TranscriptTerminalFailureFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <TranscriptStyleFixture failure="terminal" />;
}
