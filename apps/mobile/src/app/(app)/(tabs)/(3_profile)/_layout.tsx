import { Stack } from 'expo-router';
import { appSceneLayout } from '@/components/app-screen-layout';

import { TabStackErrorBoundary } from '@/components/tab-stack-error-boundary';
import { settleTabSwitchInput } from '@/lib/tab-switch-input-gate';

import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export const unstable_settings = {
  initialRouteName: 'index',
};

/**
 * The reads the screens under this stack render. A render throw can come from
 * any of their payloads, and the crashed screen is unmounted by the time Retry
 * runs, so the recovery refetches each prefix with `type: 'all'` (inactive
 * observers included) instead of rebuilding the payload that broke the render.
 * The list is every tRPC root the stack's screens read: the tab itself (user,
 * organizations, the pass and agent-profile reads) plus the code-reviewer,
 * profile-management (including its GitHub and GitLab repository reads),
 * security-agent and spend-alert screens.
 */
const PROFILE_STACK_QUERY_PREFIXES: readonly (readonly unknown[])[] = [
  [['user']],
  [['organizations']],
  [['kiloPass']],
  [['agentProfiles']],
  [['personalReviewAgent']],
  [['securityAgent']],
  [['codeReviews']],
  [['reviewMemory']],
  [['spendAlerts']],
  [['cloudAgentNext']],
];

export default function ProfileLayout() {
  useRouteForegroundRefresh([
    [['user']],
    [['organizations']],
    [['personalReviewAgent']],
    [['securityAgent']],
    [['kiloPass']],
    [['agentProfiles']],
  ]);
  // A render throw anywhere in the stack degrades to the tab's own retryable
  // error state: the tabs layout above owns the bar, so it and every other tab
  // survive instead of the root error screen replacing the app and resetting
  // navigation to Home.
  return (
    <TabStackErrorBoundary
      titleKey="common.profile"
      subsystem="profile"
      queryPrefixes={PROFILE_STACK_QUERY_PREFIXES}
    >
      <Stack
        screenLayout={appSceneLayout}
        screenOptions={{ headerShown: false }}
        // A push or a pop moves a screen that is still the touch target until
        // the transition ends, so that is where the input window can close for
        // a same-tab press.
        screenListeners={{ transitionEnd: settleTabSwitchInput }}
      />
    </TabStackErrorBoundary>
  );
}
