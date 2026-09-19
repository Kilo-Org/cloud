import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';

export function HomeScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
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

  // Landscape side safe areas (notch/Dynamic Island, Android cutouts) shift the
  // whole chrome off the sensor. The header's own chrome applies them already
  // (ScreenHeader), so the page body adds the same amount: the brand mark then
  // shares one leading edge with the section labels, the session card and the
  // actions below it. Zero insets (portrait) collapse to a no-op and leave the
  // geometry unchanged.
  const sideInsetStyle =
    insets.left > 0 || insets.right > 0
      ? {
          ...(insets.left > 0 ? { paddingLeft: insets.left } : undefined),
          ...(insets.right > 0 ? { paddingRight: insets.right } : undefined),
        }
      : undefined;

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
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
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
