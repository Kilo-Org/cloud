import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type TFunction } from 'i18next';
import { RefreshControl, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { TabScreenScrollView } from '@/components/tab-screen';

import {
  AgentSessionsSection,
  HOME_LIVE_SLOT_MIN_CLASS,
} from '@/components/home/agent-sessions-section';
import { buildTimedGreeting } from '@/components/home/greeting';
import { NewTaskButton } from '@/components/home/new-task-button';
import { ProductChoices } from '@/components/home/product-choices';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useOrganization } from '@/lib/organization-context';
import { cn } from '@/lib/utils';

export function HomeScreen() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);

  const { organizationId, isLoaded: orgLoaded } = useOrganization();

  const {
    isLoading: sessionsLoading,
    storedIsError,
    activeIsError,
    refetch: refetchSessions,
  } = useAgentSessions({
    organizationId,
    enabled: orgLoaded,
  });

  const isLoading = sessionsLoading || !orgLoaded;
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
                <Skeleton className={cn('w-full rounded-2xl', HOME_LIVE_SLOT_MIN_CLASS)} />
                <Skeleton className={cn('w-full rounded-2xl', HOME_LIVE_SLOT_MIN_CLASS)} />
                <Skeleton className={cn('w-full rounded-2xl', HOME_LIVE_SLOT_MIN_CLASS)} />
              </View>
            </Animated.View>
          ) : (
            <Animated.View entering={FadeIn.duration(200)} className="gap-2">
              {renderSessionsOrError({
                organizationId,
                storedIsError,
                activeIsError,
                handleRetrySessions: () => void refetchSessions(),
                t,
              })}

              <View className="pt-4">
                <NewTaskButton organizationId={organizationId} />
              </View>

              <ProductChoices organizationId={organizationId} />
            </Animated.View>
          )}
        </Animated.View>
      </TabScreenScrollView>
    </View>
  );
}

function renderSessionsOrError(params: {
  organizationId: string | null;
  storedIsError: boolean;
  activeIsError: boolean;
  handleRetrySessions: () => void;
  t: TFunction;
}) {
  // A stored-list failure blocks all sessions, so it wins. A cold active poll
  // failure is retryable but still hides the section until it recovers.
  // Otherwise Home always renders the section, whose placeholders cover the
  // empty Live-now state.
  if (params.storedIsError) {
    return (
      <QueryError
        placement="top"
        title={params.t('home.couldNotLoadSessions')}
        onRetry={params.handleRetrySessions}
      />
    );
  }
  if (params.activeIsError) {
    return (
      <QueryError
        placement="top"
        title={params.t('home.couldNotLoadActiveSessions')}
        onRetry={params.handleRetrySessions}
      />
    );
  }
  return <AgentSessionsSection organizationId={params.organizationId} />;
}
