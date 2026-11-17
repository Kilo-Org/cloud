import { Redirect } from 'expo-router';

import { AttachmentChipFixture } from '@/components/agents/attachment-chip-fixture';

export default function AttachmentChipFixtureRoute() {
  return __DEV__ ? <AttachmentChipFixture /> : <Redirect href="/(auth)/login" />;
}
