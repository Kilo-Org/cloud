import { Stack } from 'expo-router';
import { appSceneLayout } from '@/components/app-screen-layout';

import { TabStackErrorBoundary } from '@/components/tab-stack-error-boundary';
import { TabSwitchInputSettle } from '@/components/tab-screen-input-gate';
import { settleTabSwitchInput } from '@/lib/tab-switch-input-gate';

const CHAT_STACK_QUERY_PREFIXES: readonly (readonly unknown[])[] = [
  ['chats'],
  ['available-models'],
];

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function ChatLayout() {
  return (
    <TabSwitchInputSettle>
      <TabStackErrorBoundary
        titleKey="common.chat"
        subsystem="chat"
        queryPrefixes={CHAT_STACK_QUERY_PREFIXES}
      >
        <Stack
          screenLayout={appSceneLayout}
          screenOptions={{ headerShown: false }}
          screenListeners={{ transitionEnd: settleTabSwitchInput }}
        />
      </TabStackErrorBoundary>
    </TabSwitchInputSettle>
  );
}
