import { Stack } from 'expo-router';
import { appSceneLayout } from '@/components/app-screen-layout';

import { TabStackErrorBoundary } from '@/components/tab-stack-error-boundary';
import { settleTabSwitchInput } from '@/lib/tab-switch-input-gate';

export const unstable_settings = {
  initialRouteName: 'index',
};

/**
 * The reads the Agents screens render: the live session list, the stored
 * history pages and their search, the recent-repository read behind the
 * history header, the to-do view, and the account/organization scope the rows
 * label. A throw from any of their payloads — including a page restored from
 * the persisted read cache — must recover inside the tab instead of replacing
 * the app.
 */
const AGENTS_STACK_QUERY_PREFIXES: readonly (readonly unknown[])[] = [
  [['cliSessionsV2']],
  [['activeSessions']],
  [['todos']],
  [['user']],
  [['organizations']],
];

export default function AgentsLayout() {
  // A render throw anywhere in the stack degrades to the tab's own retryable
  // error state: the tabs layout above owns the bar, so it and every other tab
  // survive instead of the root error screen replacing the app and resetting
  // navigation to Home.
  return (
    <TabStackErrorBoundary
      titleKey="common.agents"
      subsystem="agents"
      queryPrefixes={AGENTS_STACK_QUERY_PREFIXES}
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
