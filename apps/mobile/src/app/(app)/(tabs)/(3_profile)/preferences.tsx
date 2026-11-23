import { useLocalSearchParams } from 'expo-router';

import { PreferencesScreen } from '@/components/preferences-screen';

export default function PreferencesRoute() {
  const { settingsTarget } = useLocalSearchParams<{ settingsTarget?: string }>();
  return <PreferencesScreen settingsTarget={settingsTarget} />;
}
