import { Stack } from 'expo-router';

import { ProfileStackErrorBoundary } from '@/components/profile-stack-error-boundary';
import { TabSwitchInputSettle } from '@/components/tab-screen-input-gate';
import { settleTabSwitchInput } from '@/lib/tab-switch-input-gate';

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
      {/* A render throw anywhere in the stack degrades to the tab's own
          retryable error state: the tabs layout above owns the bar, so it and
          every other tab survive instead of the root error screen replacing
          the app and resetting navigation to Home. */}
      <ProfileStackErrorBoundary>
        <Stack
          screenOptions={{ headerShown: false }}
          // A push or a pop moves a screen that is still the touch target until
          // the transition ends, so that is where the input window can close for
          // a same-tab press.
          screenListeners={{ transitionEnd: settleTabSwitchInput }}
        />
      </ProfileStackErrorBoundary>
    </TabSwitchInputSettle>
  );
}
