import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { RefreshControl } from '@/components/ui/refresh-control';
import Animated, { LinearTransition } from 'react-native-reanimated';

import logo from '@/../assets/images/logo.png';
import { Image } from '@/components/ui/image';
import { TabScreenScrollView } from '@/components/tab-screen';
import {
  AgentSessionsSection,
  LiveSessionFeedback,
} from '@/components/home/agent-sessions-section';
import { liveSessionContent, useLiveSessionContext } from '@/components/home/live-session-state';
import { buildTimedGreeting } from '@/components/home/greeting';
import { NewTaskButton } from '@/components/home/new-task-button';
import { NewTaskFromPictureButton } from '@/components/home/new-task-from-picture-button';
import { ProductChoices } from '@/components/home/product-choices';
import { ScreenHeader } from '@/components/screen-header';
import { useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';

export function HomeScreen() {
  const { t } = useTranslation();
  // The page body clears the landscape side safe areas (notch/Dynamic Island,
  // Android cutout) with the same shared hook the header chrome uses
  // (ScreenHeader), so the brand mark and the body below it always share one
  // leading edge. One implementation for both platforms; zero insets collapse
  // to a no-op and leave the portrait geometry unchanged.
  const sideInsetStyle = useSideInsetStyle();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);
  const [refreshing, setRefreshing] = useState(false);
  const context = useLiveSessionContext();
  const sessions = useLiveAgentSessions({
    organizationId: context.organizationId,
    enabled: context.isReady,
  });
  const refetch = context.isError ? context.refetch : sessions.refetch;
  const headerTitle = buildTimedGreeting();
  const liveContent = liveSessionContent(context, sessions);
  const centerFeedback =
    liveContent === 'error' && !context.isReady && !(context.accountReady && prReviewEnabled);

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
        // The logo is the header's only visible child, so this is the brand
        // mark's leading edge: it must be the page gutter the sections, cards
        // and actions use (`mx-4`), not a wider header-only gutter.
        className="px-4 pb-1"
      />
      <View className="flex-1" style={sideInsetStyle}>
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
            refreshControl={
              // One indicator per surface: while the live section is `pending`
              // it paints its own loading card, so the platform pull control
              // must not hold the scroll inset open for a second one (finding
              // home-loading; refresh-indicator.ts:20-23).
              <RefreshControl
                refreshing={refreshing && liveContent !== 'pending'}
                onRefresh={handleRefresh}
              />
            }
          >
            <Animated.View layout={LinearTransition} className="gap-2">
              <AgentSessionsSection context={context} sessions={sessions} />
              {context.isReady && (
                <View className="gap-2 pt-4">
                  <NewTaskButton organizationId={context.organizationId} />
                  <NewTaskFromPictureButton organizationId={context.organizationId} />
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
    </View>
  );
}
