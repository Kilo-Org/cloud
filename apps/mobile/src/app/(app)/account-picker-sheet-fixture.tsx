import { Redirect } from 'expo-router';

import { AccountPickerSheetFixture } from '@/components/account-picker-sheet-fixture';

export default function AccountPickerSheetFixtureRoute() {
  return __DEV__ ? <AccountPickerSheetFixture /> : <Redirect href="/(auth)/login" />;
}
