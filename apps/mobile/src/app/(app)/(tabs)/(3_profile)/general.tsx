import { useLocalSearchParams } from 'expo-router';

import { GeneralSettingsScreen } from '@/components/general-settings-screen';

export default function GeneralSettingsRoute() {
  const { settingsTarget } = useLocalSearchParams<{ settingsTarget?: string }>();
  return <GeneralSettingsScreen settingsTarget={settingsTarget} />;
}
