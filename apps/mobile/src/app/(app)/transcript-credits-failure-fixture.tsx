import { Redirect } from 'expo-router';

import { TranscriptStyleFixture } from '@/components/agents/transcript-style-fixture';

/**
 * Development-only route for the design gate: the same transcript as the
 * failure fixture, with the asked question a send the account's balance refused
 * draws. It measures the row that refusal draws — the credits statement with
 * Add credits and Copy to composer, and no resend. The development fixture path
 * in `src/app/+native-intent.tsx` maps to it, and a release build refuses the
 * path outright so the fixture is never reachable.
 */
export default function TranscriptCreditsFailureFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <TranscriptStyleFixture failure="creditsDelivery" />;
}
