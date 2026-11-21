import { useLocalSearchParams } from 'expo-router';

import { ToolSummaryTranslationSettingsScreen } from '@/components/tool-summary-translation-settings-screen';

export default function ToolSummaryTranslationSettingsRoute() {
  const { settingsTarget } = useLocalSearchParams<{ settingsTarget?: string }>();
  return <ToolSummaryTranslationSettingsScreen settingsTarget={settingsTarget} />;
}
