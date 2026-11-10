import { Redirect } from 'expo-router';

import { SaveProfileSheetFixture } from '@/components/agents/save-profile-sheet-fixture';

export default function SaveProfileSheetFixtureRoute() {
  return __DEV__ ? <SaveProfileSheetFixture /> : <Redirect href="/(auth)/login" />;
}
