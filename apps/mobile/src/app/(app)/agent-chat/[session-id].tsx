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
import { shouldRetryNotFoundOnSpawnedRoute } from '@/lib/spawned-not-found-retry';
import { useTRPC } from '@/lib/trpc';

export default function SessionDetailScreen() {
  const {
    'session-id': sessionId,
    organizationId: routeOrganizationId,
    via,
    spawned,
  } = useLocalSearchParams<{
    'session-id': string;
    organizationId?: string;
    via?: string;
    /**
     * C3b: set to `'1'` by the new-agent screen's `kilo remote` happy
     * path. When present, a transient `NOT_FOUND` from
     * `cliSessionsV2.get` (the parent ingest row has not been written
     * yet) is retried up to 8 times at 1s each before falling through
     * to the permanent not-found screen. When absent — the regression
     * case — behavior is byte-identical to pre-C3b: `retry: false`
     * everywhere, so a stale or deleted session in history still
     * shows the same permanent state it always did.
     */
    spawned?: string;
  }>();
  const trpc = useTRPC();
  const router = useRouter();
  const sessionQuery = useQuery({
    ...trpc.cliSessionsV2.get.queryOptions(
      { session_id: sessionId },
      {
        retry: (failureCount, error) =>
          shouldRetryNotFoundOnSpawnedRoute({
            spawned,
            attempt: failureCount,
            // TRPCClientErrorLike exposes `data.code`; the route's
            // existing NOT_FOUND check (`sessionQuery.error.data?.code
            // === 'NOT_FOUND'`) reads from the same field. We
            // defensively walk a couple of shapes because TRPC
            // versions across this app occasionally wrap the code
            // one level deeper.
            errorCode:
              (error as { data?: { code?: string } } | null)?.data?.code ??
              (error as { code?: string } | null)?.code,
          }),
        // kilocode_change - C3b: TanStack Query's default retryDelay is
        // exponential backoff (1s, 2s, 4s, 8s, ... capped at 30s), which
        // would stretch the 8-attempt ceiling well past the "~8s is
        // generous" budget the spawned-row window actually needs. Pin a
        // flat 1s cadence so 8 attempts stay close to 8 seconds elapsed,
        // matching the plan's stated timing. Only in effect while
        // `shouldRetryNotFoundOnSpawnedRoute` above is even allowing a
        // retry (i.e. only on the `spawned=1` NOT_FOUND path) — everywhere
        // else `retry` already returns `false` on the first failure, so
        // this delay is never consulted.
        retryDelay: 1000,
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
