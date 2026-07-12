import { type KiloSessionId } from 'cloud-agent-sdk';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';

import {
  SessionDetailContent,
  SessionSkeletonMessages,
} from '@/components/agents/session-detail-content';
import { AgentSessionProvider } from '@/components/agents/session-provider';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useTRPC } from '@/lib/trpc';

export default function SessionDetailScreen() {
  const {
    'session-id': sessionId,
    organizationId: routeOrganizationId,
    via,
  } = useLocalSearchParams<{
    'session-id': string;
    organizationId?: string;
    via?: string;
  }>();
  const trpc = useTRPC();
  const router = useRouter();
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
      <View className="flex-1 bg-background">
        <ScreenHeader title="Session" />
        <SessionSkeletonMessages />
      </View>
    );
  }

  if (routeOrganizationId === undefined && sessionQuery.isError) {
    // A NOT_FOUND (e.g. the stored session was deleted) can't be recovered by
    // retrying — show a permanent "not available" state with no Retry. Other
    // errors stay transient and retriable.
    const notFound = sessionQuery.error.data?.code === 'NOT_FOUND';
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Session" />
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <QueryError
            variant={notFound ? 'not-found' : 'server'}
            placement="top"
            className="px-0 pt-0"
            title={notFound ? undefined : 'Could not load session'}
            message={notFound ? undefined : 'Failed to load session details'}
            onRetry={notFound ? undefined : () => void sessionQuery.refetch()}
            isRetrying={sessionQuery.isFetching}
          />
          <Button
            variant="ghost"
            onPress={() => {
              router.replace('/(app)/(tabs)/(2_agents)' as Href);
            }}
          >
            <Text>Back to sessions</Text>
          </Button>
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
      <SessionDetailContent
        sessionId={sessionId as KiloSessionId}
        openedVia={via === 'push' ? 'push' : 'app'}
      />
    </AgentSessionProvider>
  );
}
