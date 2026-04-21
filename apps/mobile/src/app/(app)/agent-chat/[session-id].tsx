import { type KiloSessionId } from 'cloud-agent-sdk';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { AgentSessionProvider } from '@/components/agents/session-provider';
import { SessionDetailContent } from '@/components/agents/session-detail-content';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useTRPC } from '@/lib/trpc';

export default function SessionDetailScreen() {
  const { 'session-id': sessionId, organizationId: routeOrganizationId } = useLocalSearchParams<{
    'session-id': string;
    organizationId?: string;
  }>();
  const trpc = useTRPC();
  const sessionQuery = useQuery({
    ...trpc.cliSessionsV2.get.queryOptions(
      { session_id: sessionId },
      {
        retry: false,
      }
    ),
    enabled: routeOrganizationId === undefined,
  });

  if (routeOrganizationId === undefined && sessionQuery.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (routeOrganizationId === undefined && sessionQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Session" />
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-center text-sm text-muted-foreground">
            Failed to load session details
          </Text>
          <Pressable
            className="rounded-lg bg-secondary px-4 py-2"
            onPress={() => void sessionQuery.refetch()}
          >
            <Text className="text-sm font-medium">Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const organizationId = routeOrganizationId ?? sessionQuery.data?.organization_id ?? undefined;

  return (
    <AgentSessionProvider
      key={`${sessionId}:${organizationId ?? 'personal'}`}
      organizationId={organizationId}
    >
      <SessionDetailContent sessionId={sessionId as KiloSessionId} />
    </AgentSessionProvider>
  );
}
