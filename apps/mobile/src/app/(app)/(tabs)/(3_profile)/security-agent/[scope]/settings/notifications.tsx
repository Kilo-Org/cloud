import { useLocalSearchParams } from 'expo-router';

import { NotificationSettingsScreen } from '@/components/security-agent/notification-settings-screen';

export default function SecurityAgentNotificationSettingsRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <NotificationSettingsScreen scope={scope} />;
}
