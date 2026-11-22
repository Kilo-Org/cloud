import { useLocalSearchParams } from 'expo-router';

import { AccountSettingsScreen } from '@/components/account-settings-screen';

export default function AccountSettingsRoute() {
  const { settingsTarget } = useLocalSearchParams<{ settingsTarget?: string }>();
  return <AccountSettingsScreen settingsTarget={settingsTarget} />;
}
