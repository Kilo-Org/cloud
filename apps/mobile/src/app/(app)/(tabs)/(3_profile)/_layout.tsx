import { Stack } from 'expo-router';

import { TabSwitchInputSettle } from '@/components/tab-screen-input-gate';

import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function ProfileLayout() {
  useRouteForegroundRefresh([
    [['user']],
    [['organizations']],
    [['personalReviewAgent']],
    [['securityAgent']],
    [['kiloPass']],
    [['agentProfiles']],
  ]);
  return (
    <TabSwitchInputSettle>
      <Stack screenOptions={{ headerShown: false }} />
    </TabSwitchInputSettle>
  );
}
