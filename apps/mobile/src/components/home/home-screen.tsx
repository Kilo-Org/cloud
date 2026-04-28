import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { AgentSessionsSection } from '@/components/home/agent-sessions-section';
import { AgentsPromoCard } from '@/components/home/agents-promo-card';
import { buildTimedGreeting, Greeting } from '@/components/home/greeting';
import { KiloClawCard } from '@/components/home/kiloclaw-card';
import { KiloClawPromoCard } from '@/components/home/kiloclaw-promo-card';
import { NewTaskButton } from '@/components/home/new-task-button';
import { SectionHeader } from '@/components/home/section-header';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { useUnreadCounts } from '@/lib/hooks/use-unread-counts';
import { useOrganization } from '@/lib/organization-context';

type ClawInstance = NonNullable<ReturnType<typeof useAllKiloClawInstances>['data']>[number];

export function HomeScreen() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const { organizationId } = useOrganization();
  const {
    data: instances,
    isPending: instancesPending,
    isError: instancesError,
  } = useAllKiloClawInstances();
  const { byChannel: unreadByChannel } = useUnreadCounts();
  const {
    storedSessions,
    activeSessions,
    isLoading: sessionsLoading,
  } = useAgentSessions({
    organizationId,
  });

  const isLoading = instancesPending || sessionsLoading;

  const hasInstance = (instances?.length ?? 0) > 0;
  const hasAnySession = storedSessions.length > 0 || activeSessions.length > 0;
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
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn.duration(200)} className="gap-6">
            {renderKiloClawSlot({
              instances: instances ?? [],
              instancesError,
              unreadByChannel,
            })}

            {renderSessionsOrPromo({
              hasAnySession,
              hasInstance,
              organizationId,
            })}

            <NewTaskButton organizationId={organizationId} />
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
      <View className="gap-2">
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
  // On error we avoid misleading the user with an onboarding CTA they don't need.
  if (params.instancesError) {
    return null;
  }
  return <KiloClawPromoCard />;
}

function renderSessionsOrPromo(params: {
  hasAnySession: boolean;
  hasInstance: boolean;
  organizationId: string | null;
}) {
  if (params.hasAnySession) {
    return <AgentSessionsSection organizationId={params.organizationId} />;
  }
  if (params.hasInstance) {
    return <AgentsPromoCard />;
  }
  return null;
}
