import { useLocalSearchParams } from 'expo-router';

import { VoiceInputSettingsScreen } from '@/components/voice-input-settings-screen';

export default function VoiceInputSettingsRoute() {
  const { settingsTarget } = useLocalSearchParams<{ settingsTarget?: string }>();
  return <VoiceInputSettingsScreen settingsTarget={settingsTarget} />;
}
