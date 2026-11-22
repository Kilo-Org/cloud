import { useLocalSearchParams } from 'expo-router';

import { NotificationsScreen } from '@/components/notifications-screen';

export default function NotificationsRoute() {
  // A settings-search result opens this screen with the control it names. The
  // route only forwards the parameter: the screen keeps no router hook, so its
  // mounted suites stay router-free.
  const { settingsTarget } = useLocalSearchParams<{ settingsTarget?: string }>();
  return <NotificationsScreen settingsTarget={settingsTarget} />;
}
