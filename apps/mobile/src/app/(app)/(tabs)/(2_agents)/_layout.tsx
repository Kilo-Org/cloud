import { Stack } from 'expo-router';

import { TabSwitchInputSettle } from '@/components/tab-screen-input-gate';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function AgentsLayout() {
  return (
    <TabSwitchInputSettle>
      <Stack screenOptions={{ headerShown: false }} />
    </TabSwitchInputSettle>
  );
}
