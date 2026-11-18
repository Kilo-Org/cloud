import { Redirect } from 'expo-router';

import { TranscriptStyleFixture } from '@/components/agents/transcript-style-fixture';

export default function TranscriptStyleFixtureRoute() {
  return __DEV__ ? <TranscriptStyleFixture /> : <Redirect href="/(auth)/login" />;
}
