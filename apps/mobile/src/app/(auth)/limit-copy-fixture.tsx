import { Redirect } from 'expo-router';

import { LimitCopyProofFixture } from '@/components/agents/limit-copy-proof-fixture';

// Development-only route that renders the attachment-refusal and build-log
// limit sentences, so a device capture shows both interpolated limits.
export default function LimitCopyProofFixtureRoute() {
  return __DEV__ ? <LimitCopyProofFixture /> : <Redirect href="/(auth)/login" />;
}
