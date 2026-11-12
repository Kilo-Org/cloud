import { Stack } from 'expo-router';
import { appSceneLayout } from '@/components/app-screen-layout';

import { TabStackErrorBoundary } from '@/components/tab-stack-error-boundary';
import { settleTabSwitchInput } from '@/lib/tab-switch-input-gate';

const CHAT_STACK_QUERY_PREFIXES: readonly (readonly unknown[])[] = [
  ['chats'],
  ['available-models'],
];

export const unstable_settings = {
  initialRouteName: 'index',
  // This stack carries `TabStackErrorBoundary`, whose fallback keeps the tab's
  // own header and refetches this tab's reads. Opt out of the authenticated
  // stack's screen boundary, which would otherwise catch a tab screen's throw
  // first and take that recovery over.
  screenErrorBoundary: null,
};

export default function ChatLayout() {
  return (
    <TabStackErrorBoundary
      titleKey="common.chat"
      subsystem="chat"
      queryPrefixes={CHAT_STACK_QUERY_PREFIXES}
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
