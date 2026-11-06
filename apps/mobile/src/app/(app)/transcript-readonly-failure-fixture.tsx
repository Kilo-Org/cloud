import { Redirect } from 'expo-router';

import { TranscriptStyleFixture } from '@/components/agents/transcript-style-fixture';

/**
 * Development-only route for the design gate: the same transcript as the
 * failure fixture, with the failed turn drawn for a session that cannot accept
 * a resend. The row keeps its explanation and drops the retry, which is what a
 * read-only stored transcript and a session with no transport now show. The
 * development fixture path in `src/app/+native-intent.tsx` maps to it, and a
 * release build refuses the path outright so the fixture is never reachable.
 */
export default function TranscriptReadOnlyFailureFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <TranscriptStyleFixture retryAvailable={false} />;
}
