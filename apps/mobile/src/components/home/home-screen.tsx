import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { TabScreenScrollView } from '@/components/tab-screen';

import {
  AgentSessionsSection,
  hasDisplayableAgentSessions,
} from '@/components/home/agent-sessions-section';
import { AgentsPromoCard } from '@/components/home/agents-promo-card';
import { buildTimedGreeting } from '@/components/home/greeting';
import { NewTaskButton } from '@/components/home/new-task-button';
import { ProductChoices } from '@/components/home/product-choices';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useOrganization } from '@/lib/organization-context';

export function HomeScreen() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);

  const { organizationId, isLoaded: orgLoaded } = useOrganization();

  const {
    storedSessions,
    activeSessions,
    isLoading: sessionsLoading,
    storedIsError,
    storedIsSuccess,
    activeIsError,
    refetch: refetchSessions,
  } = useAgentSessions({
    organizationId,
    enabled: orgLoaded,
  });

  const isLoading = sessionsLoading || !orgLoaded;

  // Match what the Home Agent-sessions section actually renders (cloud-agent
  // stored + any active), so a CLI-only account shows the first-use promo
  // instead of an empty section + orphaned "New coding task" button.
  const hasAnySession = hasDisplayableAgentSessions(storedSessions, activeSessions);
  const headerTitle = buildTimedGreeting();

  const handleRefresh = useCallback(() => {
    void (async () => {
      setRefreshing(true);
      try {
        await queryClient.invalidateQueries({ refetchType: 'active' });
      } finally {
        setRefreshing(false);
      }
    })();
  }, [queryClient]);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={headerTitle} size="large" showBackButton={false} className="px-[22px]" />
      <TabScreenScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        <Animated.View layout={LinearTransition}>
          {isLoading ? (
            <Animated.View exiting={FadeOut.duration(150)} className="gap-2">
              <View className="px-4 pb-2 pt-5">
                <Skeleton className="h-3 w-28 rounded" />
              </View>
              <View className="gap-2 px-4">
                <Skeleton className="h-[72px] w-full rounded-2xl" />
                <Skeleton className="h-[72px] w-full rounded-2xl" />
              </View>
            </Animated.View>
          ) : (
            <Animated.View entering={FadeIn.duration(200)} className="gap-2">
              {renderSessionsOrPromo({
                hasAnySession,
                organizationId,
                sessionsError: storedIsError,
                sessionsLoadedEmpty: storedIsSuccess && !hasAnySession,
                activeIsError,
                handleRetrySessions: () => void refetchSessions(),
                t,
              })}

              {hasAnySession ? (
                <View className="pt-4">
                  <NewTaskButton organizationId={organizationId} />
                </View>
              ) : null}

              <ProductChoices organizationId={organizationId} />
            </Animated.View>
          )}
        </Animated.View>
      </TabScreenScrollView>
    </View>
  );
}

function renderSessionsOrPromo(params: {
  hasAnySession: boolean;
  organizationId: string | null;
  sessionsError: boolean;
  sessionsLoadedEmpty: boolean;
  activeIsError: boolean;
  handleRetrySessions: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  // Stale stored history always wins over an error (e.g. a live-poll blip
  // on the active-sessions query) — never blank out sessions we already
  // have. The first-use promo only appears after a confirmed empty
  // response, never merely because the fetch hasn't succeeded yet.
  if (params.hasAnySession) {
    return <AgentSessionsSection organizationId={params.organizationId} />;
  }
  if (params.sessionsError) {
    return (
      <QueryError
        placement="top"
        title={params.t('home.couldNotLoadSessions')}
        onRetry={params.handleRetrySessions}
      />
    );
  }
  // Cold active-only failure: the stored query succeeded empty but the active
  // poll failed before any data loaded. Retryable, so never claim first-use.
  if (params.activeIsError) {
    return (
      <QueryError
        placement="top"
        title={params.t('home.couldNotLoadActiveSessions')}
        onRetry={params.handleRetrySessions}
      />
    );
  }
  if (params.sessionsLoadedEmpty) {
    return <AgentsPromoCard organizationId={params.organizationId} />;
  }
  return null;
}
