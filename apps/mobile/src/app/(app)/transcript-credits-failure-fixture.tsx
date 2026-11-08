import { Redirect } from 'expo-router';

import { TranscriptStyleFixture } from '@/components/agents/transcript-style-fixture';

/**
 * Development-only route for the design gate: the same transcript as the
 * failure fixture, with the failed turn the Kilo gateway answered with a
 * payment block (402 and its `usage_limit_exceeded` body). It measures the row
 * a balance refusal draws — the credits copy and Add credits, with no resend.
 * The development fixture path in `src/app/+native-intent.tsx` maps to it, and
 * a release build refuses the path outright so the fixture is never reachable.
 */
export default function TranscriptCreditsFailureFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <TranscriptStyleFixture failure="credits" />;
}
