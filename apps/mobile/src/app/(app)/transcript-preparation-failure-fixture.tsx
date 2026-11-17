import { Redirect } from 'expo-router';

import { TranscriptStyleFixture } from '@/components/agents/transcript-style-fixture';

/**
 * Development-only route for the design gate: the question whose sandbox
 * preparation failed, with the preparation group under it naming the stage that
 * stopped and the reason. The group states the failure, so the question's row
 * keeps only its recovery actions. The development fixture path in
 * `src/app/+native-intent.tsx` maps to it, and a release build refuses the path
 * outright so the fixture is never reachable.
 */
export default function TranscriptPreparationFailureFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <TranscriptStyleFixture failure="preparation" />;
}
