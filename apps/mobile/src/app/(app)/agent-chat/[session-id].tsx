import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { hashKey, useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMemo, useRef, useSyncExternalStore } from 'react';

import {
  getAuthenticatedOwner,
  isAuthenticatedOwner,
  subscribeAuthenticatedOwner,
} from '@/lib/context-scope';
import { useAuth } from '@/lib/auth/auth-context';
import { readUserIdFromToken } from '@/lib/auth/token-user-id';

import { SessionDetailContent } from '@/components/agents/session-detail-content';
import {
  SessionComposerSkeleton,
  SessionSkeletonMessages,
} from '@/components/agents/session-detail-skeleton';
import { SessionContextMetrics } from '@/components/agents/session-context-metrics';
import { AgentSessionProvider } from '@/components/agents/session-provider';
import { useSessionSlowLoadPhase } from '@/components/agents/session-slow-load';
import { useIdentityConfirmation } from '@/components/agents/user-web-connection-provider';
import { buildTerminalErrorCopyText } from '@/components/agents/session-terminal-error';
import { performCopy } from '@/components/agents/use-message-copy';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { CenteredState } from '@/components/centered-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { parseParam } from '@/lib/route-params';
import { useRestoredAccountId } from '@/lib/hooks/use-restored-account-id';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { shouldRetryNotFoundOnSpawnedRoute } from '@/lib/spawned-not-found-retry';
import { useTRPC } from '@/lib/trpc';

export default function SessionDetailScreen() {
  const owner = useSyncExternalStore(subscribeAuthenticatedOwner, getAuthenticatedOwner);
  const confirmation = useIdentityConfirmation();
  const {
    'session-id': rawSessionId,
    organizationId: routeOrganizationId,
    via,
    spawned,
    shareId: shareIdParam,
    autoSend: autoSendRaw,
    mode: modeParam,
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
    shareId?: string;
    autoSend?: string;
    /** Agent mode the spawn was started with; seeds the composer before the CLI reports one. */
    mode?: string;
    /** Legacy title hints remain accepted but carry no account ownership, so ignore them. */
    title?: string;
  }>();
  // `session-id` is required: a malformed deep link can hand us `undefined`
  // or a `string[]`, both of which parseParam rejects. Optional params keep
  // the existing first-element unwrapping below.
  const sessionId = parseParam(rawSessionId);
  // Param can be string | string[] depending on how the route was opened.
  const shareId = Array.isArray(shareIdParam) ? shareIdParam[0] : shareIdParam;
  const autoSendParam = Array.isArray(autoSendRaw) ? autoSendRaw[0] : autoSendRaw;
  const spawnedMode = Array.isArray(modeParam) ? modeParam[0] : modeParam;
  const trpc = useTRPC();
  const router = useRouter();
  const { t } = useTranslation();
  // The open's clock starts at route mount — before the metadata query and
  // the transcript screen — so the slow-load threshold measures from when
  // the user tapped, not from when SessionDetailContent happens to mount.
  // Keyed on the session id: a reused route instance opening a different
  // session restarts the clock.
  const openStart = useRef({ sessionId: rawSessionId, startedAt: Date.now() });
  if (openStart.current.sessionId !== rawSessionId) {
    openStart.current = { sessionId: rawSessionId, startedAt: Date.now() };
  }
  useRouteForegroundRefresh([[['cliSessionsV2']], [['modelPreferences']]]);
  const sessionQuery = useQuery({
    ...trpc.cliSessionsV2.get.queryOptions(
      { session_id: sessionId ?? '' },
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
    // Isolate account metadata while preserving the typed tRPC key and prefix invalidation.
    queryHash: hashKey([
      ...trpc.cliSessionsV2.get.queryKey({ session_id: sessionId ?? '' }),
      owner.authEpoch,
      owner.generation,
      owner.userId,
    ]),
    enabled: isAuthenticatedOwner(owner) && routeOrganizationId === undefined && sessionId !== null,
  });

  // The account that owns this device's persisted transcript. The live
  // confirmation wins; the id restored from the encrypted read cache keeps the
  // cached transcript readable when the account cannot be confirmed at all —
  // the API unreachable on a cold start. That id is written only after an
  // authoritative `user.getMe` for the current credentials, and the cold-start
  // restore is fenced on the auth epoch, so it can never scope another
  // account's rows.
  //
  // The restored id may only scope the session when it agrees with the account
  // the active credentials name. A direct credential switch bumps the epoch
  // before the new `getMe` lands, so the hint still names the previous account
  // until that `getMe` rewrites it; mounting on it would paint the previous
  // account's cached transcript under the new session. The route stays in its
  // pending state until the credentials' own `getMe` confirms. An undecodable
  // token (a legacy credential before its exchange) leaves the restore behavior
  // intact; a token that positively names a different account does not.
  const { token: credentialToken, isSigningOut } = useAuth();
  const credentialUserId = useMemo(
    () => (credentialToken ? readUserIdFromToken(credentialToken) : null),
    [credentialToken]
  );
  const restoredUserId = useRestoredAccountId(owner.authEpoch);
  const credentialMatchesRestore =
    !isSigningOut && (credentialUserId === null || credentialUserId === restoredUserId);
  const scopedRestoredUserId = credentialMatchesRestore ? restoredUserId : null;
  const sessionScopeUserId = owner.userId ?? scopedRestoredUserId;
  const identityPending = sessionScopeUserId === null;
  const identityFailed = identityPending && confirmation.isError;

  const displayScope = {
    organizationId: routeOrganizationId ?? sessionQuery.data?.organization_id ?? null,
    isResolved: routeOrganizationId !== undefined || sessionQuery.data != null,
  };

  // The live account confirmed the session; a pending metadata read only
  // decides the organization the provider mounts with, so the skeleton holds
  // while that read can still answer on its own. Two shapes cannot resolve, and
  // both must hand off to the session, which owns the retryable state and paints
  // the persisted transcript:
  //  - the scope came from the restored identity instead (the API is
  //    unreachable), so the metadata read cannot answer either;
  //  - the read will not run because the device is offline (React Query pauses
  //    it), or it has outlived the open's grace — the same threshold the session
  //    body applies to a stalled transport. Holding the skeleton there keeps an
  //    offline or stalled open spinning forever with a composer nobody can use.
  const scopeFromRestoredIdentity = owner.userId === null && sessionScopeUserId !== null;
  const metadataReadWaiting = !scopeFromRestoredIdentity && sessionQuery.fetchStatus !== 'paused';
  const metadataPhase = useSessionSlowLoadPhase({
    isLoading: metadataReadWaiting && routeOrganizationId === undefined && sessionQuery.isPending,
    hasContent: routeOrganizationId !== undefined || sessionQuery.data != null,
    hasError: sessionQuery.isError,
    hasStatusIndicator: false,
    openStartedAt: openStart.current.startedAt,
  });

  if (sessionId === null) {
    return <InvalidRouteState backTo={'/(app)' as Href} />;
  }

  if (!identityFailed && (identityPending || metadataPhase === 'loading')) {
    // The composer placeholder holds its own height: nothing may shift when
    // the query resolves. Route title hints are not bound to an account.
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('agentChat.session.title')}
          reserveTitleSpace
          backFallback="/(app)/(tabs)/(2_agents)"
          headerRight={
            <SessionContextMetrics
              info={undefined}
              totalCostMicrodollars={null}
              hasMessages={false}
              loading
            />
          }
        />
        <SessionSkeletonMessages sessionId={sessionId} />
        <SessionComposerSkeleton />
      </View>
    );
  }

  const metadataErrorCode = sessionQuery.error?.data?.code;
  const metadataAccessDenied =
    metadataErrorCode === 'NOT_FOUND' ||
    metadataErrorCode === 'UNAUTHORIZED' ||
    metadataErrorCode === 'FORBIDDEN';
  // A failed background refresh does not invalidate owner-scoped cached
  // metadata. Keep its provider mounted; only an authoritative denial retires it.
  // A retryable metadata failure must not blank a session either: the device may
  // still hold its persisted transcript, so mount the session and let the SDK
  // paint the cached content and surface the retryable failure in place. Only a
  // denial (deleted session / lost access) replaces the screen with the error.
  if (
    identityFailed ||
    (routeOrganizationId === undefined && sessionQuery.isError && metadataAccessDenied)
  ) {
    // An identity failure stays retriable. An authoritative metadata denial
    // (NOT_FOUND / UNAUTHORIZED / FORBIDDEN) can't be recovered by retrying, so
    // it shows a permanent state with no Retry. Both get Back and Copy.
    const errorCode = identityFailed ? undefined : sessionQuery.error?.data?.code;
    const notFound = errorCode === 'NOT_FOUND';
    const unauthorized = errorCode === 'UNAUTHORIZED' || errorCode === 'FORBIDDEN';
    let title = t(
      identityFailed ? 'bootstrap.couldNotLoadAccount' : 'agentChat.session.couldNotLoad'
    );
    let message = t(
      identityFailed
        ? 'organization.boundary.loadErrorMessage'
        : 'agentChat.session.failedToLoadDetails'
    );
    let variant: 'neutral' | 'not-found' | 'permission' | 'server' = identityFailed
      ? 'neutral'
      : 'server';
    if (notFound) {
      title = t('common.notFound');
      message = t('queryError.notFoundDescription');
      variant = 'not-found';
    } else if (unauthorized) {
      title = t('common.accessDenied');
      message = t('queryError.permissionDescription');
      variant = 'permission';
    }
    const retry = identityFailed ? confirmation.retry : () => void sessionQuery.refetch();
    const copyText = buildTerminalErrorCopyText({ sessionId, title, message });
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('agentChat.session.title')}
          reserveTitleSpace
          backFallback="/(app)/(tabs)/(2_agents)"
        />
        <CenteredState>
          <View className="items-center gap-3 px-6">
            <QueryError
              variant={variant}
              placement="top"
              className="px-0 pt-0"
              title={title}
              message={message}
              onRetry={notFound || unauthorized ? undefined : retry}
              isRetrying={identityFailed ? confirmation.isPending : sessionQuery.isFetching}
            />
            <View className="flex-row gap-3">
              <Button
                variant="ghost"
                accessibilityLabel={t('agentChat.session.copyErrorDetails')}
                onPress={() => {
                  void performCopy(copyText);
                }}
              >
                <Text>{t('common.copy')}</Text>
              </Button>
              <Button
                variant="ghost"
                onPress={() => {
                  router.replace('/(app)/(tabs)/(2_agents)' as Href);
                }}
              >
                <Text>{t('agentChat.session.backToSessions')}</Text>
              </Button>
            </View>
          </View>
        </CenteredState>
      </View>
    );
  }

  const organizationId = routeOrganizationId ?? sessionQuery.data?.organization_id ?? undefined;

  return (
    <AgentSessionProvider
      // Keyed on the resolved account scope, not the live owner: a cold start
      // mounts with `owner.userId === null` and the restored id, and the live
      // `getMe` confirmation arrives later. Confirming the same account must
      // not remount the session subtree — the manager, transcript and composer
      // text all live below this key — while a stale or different hint still
      // remounts because the resolved id changes.
      //
      // The metadata-derived organization is deliberately not part of the key:
      // the metadata read can be paused or stalled when this route mounts the
      // session on its persisted transcript (see `metadataPhase` above), and
      // the manager adopts the organization its own read resolves, so re-keying
      // on it would remount — new manager, transcript flash, composer text
      // lost — for a scope the manager applies in place. An explicit route
      // organization still re-keys, because it is authoritative from the first
      // frame.
      key={`${owner.generation}:${sessionScopeUserId}:${sessionId}:${routeOrganizationId ?? 'personal'}`}
      organizationId={organizationId}
      restoredUserId={scopedRestoredUserId ?? undefined}
    >
      <SessionDetailContent
        sessionId={sessionId as KiloSessionId}
        cachedTitle={sessionQuery.data?.title ?? undefined}
        displayScope={displayScope}
        openedVia={via === 'push' ? 'push' : 'app'}
        shareId={shareId}
        autoSend={autoSendParam === '1'}
        spawnedMode={spawnedMode}
        openStartedAt={openStart.current.startedAt}
      />
    </AgentSessionProvider>
  );
}
