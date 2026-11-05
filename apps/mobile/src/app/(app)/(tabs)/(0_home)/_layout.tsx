import { Stack } from 'expo-router';
import { appSceneLayout } from '@/components/app-screen-layout';

import { TabStackErrorBoundary } from '@/components/tab-stack-error-boundary';
import { settleTabSwitchInput } from '@/lib/tab-switch-input-gate';

import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export const unstable_settings = {
  initialRouteName: 'index',
  // This stack carries `TabStackErrorBoundary`, whose fallback keeps the tab's
  // own header and refetches this tab's reads. Opt out of the authenticated
  // stack's screen boundary, which would otherwise catch a tab screen's throw
  // first and take that recovery over.
  screenErrorBoundary: null,
};

/**
 * The reads the Home screens render: the live session list, the briefing card,
 * the up-next to-dos, and the account/organization scope the header shows. A
 * throw from any of their payloads must recover inside the tab instead of
 * replacing the app.
 */
const HOME_STACK_QUERY_PREFIXES: readonly (readonly unknown[])[] = [
  [['activeSessions']],
  [['agentBriefing']],
  [['todos']],
  [['user']],
  [['organizations']],
];

export default function HomeLayout() {
  useRouteForegroundRefresh([[['activeSessions']]]);
  // A render throw anywhere in the stack degrades to the tab's own retryable
  // error state: the tabs layout above owns the bar, so it and every other tab
  // survive instead of the root error screen replacing the app and resetting
  // navigation to Home.
  return (
    <TabStackErrorBoundary
      titleKey="tabs.home"
      subsystem="home"
      queryPrefixes={HOME_STACK_QUERY_PREFIXES}
    >
      <Stack
        // A blurred tab keeps its state but stops its effects, timers and
        // queries. The tabs navigator cannot: its screens are groups, and the
        // router wraps only route nodes.
        activityEnabled={1}
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
