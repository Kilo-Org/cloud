import { Stack } from 'expo-router';

import { TabSwitchInputSettle } from '@/components/tab-screen-input-gate';

import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function HomeLayout() {
  useRouteForegroundRefresh([[['activeSessions']]]);
  return (
    <TabSwitchInputSettle>
      <Stack screenOptions={{ headerShown: false }} />
    </TabSwitchInputSettle>
  );
}
