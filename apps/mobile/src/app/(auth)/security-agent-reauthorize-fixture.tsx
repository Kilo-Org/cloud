import { Redirect } from 'expo-router';

import { ScopeEntryReauthorizeFixture } from '@/components/security-agent/scope-entry-reauthorize-fixture';

export default function ScopeEntryReauthorizeFixtureRoute() {
  return __DEV__ ? <ScopeEntryReauthorizeFixture /> : <Redirect href="/(auth)/login" />;
}
