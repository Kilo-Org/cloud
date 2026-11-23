import { Redirect } from 'expo-router';

import { SettingsCountProofFixture } from '@/components/security-agent/settings-count-proof-fixture';

// Development-only route that renders the real settings overview with a seeded
// config, so a device capture shows the counted subtitles without a backend.
export default function SettingsCountProofFixtureRoute() {
  return __DEV__ ? <SettingsCountProofFixture /> : <Redirect href="/(auth)/login" />;
}
