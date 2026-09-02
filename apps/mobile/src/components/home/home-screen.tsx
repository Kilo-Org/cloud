import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import logo from '@/../assets/images/logo.png';
import { Image } from '@/components/ui/image';
import { TabScreenScrollView } from '@/components/tab-screen';
import {
  AgentSessionsSection,
  liveSessionContent,
  LiveSessionFeedback,
  useLiveSessionContext,
} from '@/components/home/agent-sessions-section';
import { buildTimedGreeting } from '@/components/home/greeting';
import { NewTaskButton } from '@/components/home/new-task-button';
import { ProductChoices } from '@/components/home/product-choices';
import { ScreenHeader } from '@/components/screen-header';
import { useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';

export function HomeScreen() {
  const { t } = useTranslation();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);
  const [refreshing, setRefreshing] = useState(false);
  const context = useLiveSessionContext();
  const sessions = useLiveAgentSessions({
    organizationId: context.organizationId,
    enabled: context.isReady,
  });
  const refetch = context.isError ? context.refetch : sessions.refetch;
  const headerTitle = buildTimedGreeting();
  const centerFeedback =
    liveSessionContent(context, sessions) === 'error' &&
    !context.isReady &&
    !(context.accountReady && prReviewEnabled);

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
        titleContent={
          <Image
            source={logo}
            className="size-[40px] shrink-0"
            contentFit="contain"
            transition={0}
            accessible={false}
          />
        }
        size="large"
        showBackButton={false}
        className="px-[22px]"
      />
      {centerFeedback ? (
        <LiveSessionFeedback
          context={context}
          sessions={sessions}
          failureLabel={t('home.couldNotLoadActiveSessions')}
          centered
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        />
      ) : (
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
      )}
    </View>
  );
}
