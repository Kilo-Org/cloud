import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, RefreshControl, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { TabScreenScrollView } from '@/components/tab-screen';

import { badgeBucketForInstance } from '@kilocode/notifications';

import {
  AgentSessionsSection,
  hasDisplayableAgentSessions,
} from '@/components/home/agent-sessions-section';
import { AgentsPromoCard } from '@/components/home/agents-promo-card';
import { buildTimedGreeting } from '@/components/home/greeting';
import { KiloClawPromoCard } from '@/components/home/kiloclaw-promo-card';
import { NewTaskButton } from '@/components/home/new-task-button';
import { SectionHeader } from '@/components/home/section-header';
import { KiloClawCard } from '@/components/kiloclaw/instance-card';
import { isTransitionalStatus } from '@/components/kiloclaw/status-badge';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { type ClawInstance, useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { useUnreadCounts } from '@/lib/hooks/use-unread-counts';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';

const DEFAULT_LIST_POLL_MS = 30_000;
const TRANSITIONAL_POLL_MS = 5000;

function pickListPollInterval(instances: ClawInstance[] | undefined): number {
  const hasTransitional = (instances ?? []).some(i => isTransitionalStatus(i.status));
  return hasTransitional ? TRANSITIONAL_POLL_MS : DEFAULT_LIST_POLL_MS;
}

export function HomeScreen() {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const isFocused = useIsFocused();
  const [refreshing, setRefreshing] = useState(false);

  const { organizationId } = useOrganization();

  const invalidateHomeQueries = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: trpc.kiloclaw.listAllInstances.queryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.kiloclaw.getStatus.queryKey(),
    });
    void queryClient.invalidateQueries({ queryKey: ['kiloclaw-latest-message'] });
  }, [queryClient, trpc.kiloclaw.getStatus, trpc.kiloclaw.listAllInstances]);

  useFocusEffect(
    useCallback(() => {
      invalidateHomeQueries();
    }, [invalidateHomeQueries])
  );

  // Foregrounding the app doesn't trigger `useFocusEffect`; cover that case
  // with an AppState listener, gated on focus so we don't refetch when Home
  // is not the visible tab.
  useEffect(() => {
    if (!isFocused) {
      return undefined;
    }
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'active') {
        invalidateHomeQueries();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [isFocused, invalidateHomeQueries]);

  // Upshift polling while any instance is transitional. react-query's
  // `refetchInterval` function form re-evaluates after every fetch, so the
  // cadence adapts as the list resolves. `getStatus` polling is upshifted
  // per card (see `KiloClawCard`).
  const {
    data: instances,
    isPending: instancesPending,
    isError: instancesError,
    refetch: refetchInstances,
  } = useAllKiloClawInstances(pickListPollInterval);
  const { byBadgeBucket: unreadByBadgeBucket } = useUnreadCounts();
  const {
    storedSessions,
    activeSessions,
    isLoading: sessionsLoading,
    storedIsError,
    storedIsSuccess,
    refetch: refetchSessions,
  } = useAgentSessions({
    organizationId,
  });

  const isLoading = instancesPending || sessionsLoading;

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
                <Skeleton className="h-3 w-20 rounded" />
              </View>
              <View className="gap-3 px-4">
                <Skeleton className="h-[72px] w-full rounded-2xl" />
              </View>
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
              {renderKiloClawSlot({
                instances: instances ?? [],
                instancesError,
                handleRetryInstances: () => void refetchInstances(),
                unreadByBadgeBucket,
              })}

              {renderSessionsOrPromo({
                hasAnySession,
                organizationId,
                sessionsError: storedIsError,
                sessionsLoadedEmpty: storedIsSuccess && !hasAnySession,
                handleRetrySessions: () => void refetchSessions(),
              })}

              {hasAnySession ? (
                <View className="pt-4">
                  <NewTaskButton organizationId={organizationId} />
                </View>
              ) : null}
            </Animated.View>
          )}
        </Animated.View>
      </TabScreenScrollView>
    </View>
  );
}

function renderKiloClawSlot(params: {
  instances: ClawInstance[];
  instancesError: boolean;
  handleRetryInstances: () => void;
  unreadByBadgeBucket: Map<string, number>;
}) {
  // Stale data (a previously successful fetch) always wins over a
  // background-refetch failure — only an initial-load failure with no
  // instances at all should replace the section with an error state.
  if (params.instances.length > 0) {
    return (
      <View>
        <SectionHeader label="KiloClaw" />
        <View className="gap-3">
          {params.instances.map(instance => (
            <KiloClawCard
              key={instance.sandboxId}
              instance={instance}
              unreadCount={
                params.unreadByBadgeBucket.get(badgeBucketForInstance(instance.sandboxId)) ?? 0
              }
            />
          ))}
        </View>
      </View>
    );
  }
  if (params.instancesError) {
    return (
      <QueryError
        placement="top"
        title="Couldn't load KiloClaw"
        onRetry={params.handleRetryInstances}
      />
    );
  }
  return <KiloClawPromoCard />;
}

function renderSessionsOrPromo(params: {
  hasAnySession: boolean;
  organizationId: string | null;
  sessionsError: boolean;
  sessionsLoadedEmpty: boolean;
  handleRetrySessions: () => void;
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
        title="Couldn't load sessions"
        onRetry={params.handleRetrySessions}
      />
    );
  }
  if (params.sessionsLoadedEmpty) {
    return <AgentsPromoCard organizationId={params.organizationId} />;
  }
  return null;
}
