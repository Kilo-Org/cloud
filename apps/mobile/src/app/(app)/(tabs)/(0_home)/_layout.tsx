import { Stack } from 'expo-router';
import { appSceneLayout } from '@/components/app-screen-layout';

import { TabSwitchInputSettle } from '@/components/tab-screen-input-gate';
import { settleTabSwitchInput } from '@/lib/tab-switch-input-gate';

import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function HomeLayout() {
  useRouteForegroundRefresh([[['activeSessions']]]);
  return (
    <TabSwitchInputSettle>
      <Stack
        screenLayout={appSceneLayout}
        screenOptions={{ headerShown: false }}
        // A push or a pop moves a screen that is still the touch target until
        // the transition ends, so that is where the input window can close for
        // a same-tab press.
        screenListeners={{ transitionEnd: settleTabSwitchInput }}
      />
    </TabSwitchInputSettle>
  );
}
