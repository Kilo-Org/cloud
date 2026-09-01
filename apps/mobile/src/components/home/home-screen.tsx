import { useCallback, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { TabScreenScrollView } from '@/components/tab-screen';
import {
  AgentSessionsSection,
  useLiveSessionContext,
} from '@/components/home/agent-sessions-section';
import { buildTimedGreeting } from '@/components/home/greeting';
import { NewTaskButton } from '@/components/home/new-task-button';
import { ProductChoices } from '@/components/home/product-choices';
import { ContextControl } from '@/components/context-control';
import { ScreenHeader } from '@/components/screen-header';
import { useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';

export function HomeScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const context = useLiveSessionContext();
  const sessions = useLiveAgentSessions({
    organizationId: context.organizationId,
    enabled: context.isReady,
  });
  const { refetch } = sessions;
  const headerTitle = buildTimedGreeting();

  const handleRefresh = useCallback(() => {
    void (async () => {
      setRefreshing(true);
      try {
        await refetch();
      } finally {
        setRefreshing(false);
      }
    })();
  }, [refetch]);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={headerTitle}
        size="large"
        showBackButton={false}
        className="px-[22px]"
        contextPosition="right"
        context={
          <ContextControl
            showOrganizationName={context.isReady}
            scope={context.accountReady ? undefined : { organizationId: null, isResolved: false }}
          />
        }
      />
      <TabScreenScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        <Animated.View layout={LinearTransition} className="gap-2">
          <AgentSessionsSection context={context} sessions={sessions} />
          {context.isReady && (
            <View className="pt-4">
              <NewTaskButton organizationId={context.organizationId} />
            </View>
          )}
          {context.accountReady && (
            <ProductChoices
              organizationId={context.organizationId}
              contextReady={context.isReady}
            />
          )}
        </Animated.View>
      </TabScreenScrollView>
    </View>
  );
}
