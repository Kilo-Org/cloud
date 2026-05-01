import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, RefreshControl, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { AgentSessionsSection } from '@/components/home/agent-sessions-section';
import { AgentsPromoCard } from '@/components/home/agents-promo-card';
import { buildTimedGreeting, Greeting } from '@/components/home/greeting';
import { KiloClawCard } from '@/components/home/kiloclaw-card';
import { KiloClawPromoCard } from '@/components/home/kiloclaw-promo-card';
import { NewTaskButton } from '@/components/home/new-task-button';
import { SectionHeader } from '@/components/home/section-header';
import { isTransitionalStatus } from '@/components/kiloclaw/status-badge';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
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
  } = useAllKiloClawInstances(pickListPollInterval);
  const { byChannel: unreadByChannel } = useUnreadCounts();
  const {
    storedSessions,
    activeSessions,
    isLoading: sessionsLoading,
  } = useAgentSessions({
    organizationId,
  });

  const isLoading = instancesPending || sessionsLoading;

  const hasAnySession = storedSessions.length > 0 || activeSessions.length > 0;
  const hasInstance = (instances?.length ?? 0) > 0;
  const isFirstTime = !hasInstance && !hasAnySession && !instancesError;

  const title = isFirstTime ? 'Welcome to Kilo' : buildTimedGreeting(null);

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
      <ScreenHeader title="Kilo" showBackButton={false} headerRight={<ProfileAvatarButton />} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-24"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        <Greeting title={title} />

        {isLoading ? (
          <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-4">
            <Skeleton className="h-20 w-full rounded-2xl" />
            <Skeleton className="h-20 w-full rounded-2xl" />
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn.duration(200)} className="gap-2">
            {renderKiloClawSlot({
              instances: instances ?? [],
              instancesError,
              unreadByChannel,
            })}

            {renderSessionsOrPromo({
              hasAnySession,
              organizationId,
            })}

            {hasAnySession ? (
              <View className="pt-4">
                <NewTaskButton organizationId={organizationId} />
              </View>
            ) : null}
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

function renderKiloClawSlot(params: {
  instances: ClawInstance[];
  instancesError: boolean;
  unreadByChannel: Map<string, number>;
}) {
  if (params.instances.length > 0) {
    return (
      <View>
        <SectionHeader label="KiloClaw" />
        <View className="gap-3">
          {params.instances.map(instance => (
            <KiloClawCard
              key={instance.sandboxId}
              instance={instance}
              unreadCount={params.unreadByChannel.get(instance.sandboxId) ?? 0}
            />
          ))}
        </View>
      </View>
    );
  }
  if (params.instancesError) {
    return null;
  }
  return <KiloClawPromoCard />;
}

function renderSessionsOrPromo(params: { hasAnySession: boolean; organizationId: string | null }) {
  if (params.hasAnySession) {
    return <AgentSessionsSection organizationId={params.organizationId} />;
  }
  return <AgentsPromoCard organizationId={params.organizationId} />;
}
