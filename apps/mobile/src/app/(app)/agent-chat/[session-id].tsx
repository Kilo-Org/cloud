import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { type Href, useLocalSearchParams } from 'expo-router';
import { hashKey, useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRef, useSyncExternalStore } from 'react';

import {
  getAuthenticatedOwner,
  isAuthenticatedOwner,
  subscribeAuthenticatedOwner,
} from '@/lib/context-scope';

import { SessionDetailContent } from '@/components/agents/session-detail-content';
import { SESSION_HEADER_TITLE_LINES } from '@/components/agents/session-header';
import {
  SessionComposerSkeleton,
  SessionReadOnlyFooterPlaceholder,
  SessionSkeletonMessages,
} from '@/components/agents/session-detail-skeleton';
import { SessionContextMetrics } from '@/components/agents/session-context-metrics';
import { AgentSessionProvider } from '@/components/agents/session-provider';
import { useSessionSlowLoadPhase } from '@/components/agents/session-slow-load';
import { useIdentityConfirmation } from '@/components/agents/user-web-connection-provider';
import { buildTerminalErrorCopyText } from '@/components/agents/session-terminal-error';
import { SessionPermanentError } from '@/components/agents/session-permanent-error';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { ScreenHeader } from '@/components/screen-header';
import { parseParam } from '@/lib/route-params';
import { AGENTS_SESSIONS_HREF } from '@/lib/agents-sessions-route';
import { isAddressableStoredSessionId } from '@/lib/session-id-shape';
import { useRestoredRouteOpen } from '@/lib/hooks/use-restored-route-open';
import { useSessionRouteBack } from '@/lib/navigation/session-route-back';
import { sessionDisplayTitle } from '@/lib/session-display-title';
import { parseResumeAnchor } from '@/lib/session-resume';
import { useRestoredAccountId } from '@/lib/hooks/use-restored-account-id';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { shouldRetrySessionNotFound } from '@/lib/spawned-not-found-retry';
import { useTRPC } from '@/lib/trpc';

export default function SessionDetailScreen() {
  const owner = useSyncExternalStore(subscribeAuthenticatedOwner, getAuthenticatedOwner);
  const confirmation = useIdentityConfirmation();
  const {
    'session-id': rawSessionId,
    organizationId: routeOrganizationId,
    via,
    spawned,
    cloned,
    shareId: shareIdParam,
    autoSend: autoSendRaw,
    mode: modeParam,
    at: resumeAtRaw,
  } = useLocalSearchParams<{
    'session-id': string;
    organizationId?: string;
    via?: string;
    /**
     * C3b: set to `'1'` by the new-agent screen's `kilo remote` happy
     * path. A transient `NOT_FOUND` from `cliSessionsV2.get` (the
     * ingest row has not been written yet) is retried up to 8 times at
     * 1s each before falling through to the permanent not-found screen —
     * whether or not this param is present. The param only marks the
     * spawn flow itself; every other open gets the same window through
     * the young-route retry, except an open that began on the restored
     * identity, whose denial must stay immediate (the retry callback
     * below owns that skip).
     */
    spawned?: string;
    /** `'1'` when the spawn cloned a session onto a remote CLI; its first page waits for the sync. */
    cloned?: string;
    shareId?: string;
    autoSend?: string;
    /** Agent mode the spawn was started with; seeds the composer before the CLI reports one. */
    mode?: string;
    /**
     * Resume anchor: the message id a `?at=` deep link recorded on the other
     * device. Missing or unknown is not an error — the session opens at the
     * bottom exactly as it does without the param.
     */
    at?: string;
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
  const resumeAt = parseResumeAnchor(resumeAtRaw);
  // Whether the relaunch repair opened this destination. It is keyed on the
  // destination this screen renders, never on the focused route's pathname: a
  // sheet or a share gate in front of this screen must not answer for it.
  const restoredOpen = useRestoredRouteOpen(
    sessionId === null ? '' : `/(app)/agent-chat/${sessionId}`
  );
  const trpc = useTRPC();
  const { t } = useTranslation();
  // System Back answers the way the header's back control does: it pops the
  // route the person came from, and it never leaves the app while this screen
  // is open.
  useSessionRouteBack();
  // The open's clock starts at route mount — before the metadata query and
  // the transcript screen — so the slow-load threshold measures from when
  // the user tapped, not from when SessionDetailContent happens to mount.
  // Keyed on the session id: a reused route instance opening a different
  // session restarts the clock.
  const openStart = useRef({ sessionId: rawSessionId, startedAt: Date.now() });
  if (openStart.current.sessionId !== rawSessionId) {
    openStart.current = { sessionId: rawSessionId, startedAt: Date.now() };
  }
  const sessionRendered = useRef<string | null>(null);
  if (sessionRendered.current !== null && sessionRendered.current !== rawSessionId) {
    // A reused route instance opening a different session restarts the
    // rendered guard with the clock.
    sessionRendered.current = null;
  }
  // Narrow the metadata invalidation to this session's own query key. The whole
  // `cliSessionsV2` procedure prefix would also invalidate the stored
  // `cliSessionsV2.list` pages behind this pushed route, so returning to the app
  // (or refocusing the route) refetched every retained list page alongside the
  // metadata. `SessionDetailContent` already refetches `getWithRuntimeState` on
  // focus, and this key still refreshes the opened session's metadata.
  useRouteForegroundRefresh([
    trpc.cliSessionsV2.get.queryKey({ session_id: sessionId ?? '' }),
    [['modelPreferences']],
  ]);

  // The account that owns this device's persisted transcript. The live
  // confirmation wins; the id restored from the encrypted read cache keeps the
  // cached transcript readable only when the account cannot be confirmed at all
  // — the API unreachable on a cold start. That id is written only after an
  // authoritative `user.getMe` for the current credentials, and the cold-start
  // restore is fenced on the auth epoch, so it can never scope another
  // account's rows. Sign-in clears the prior hint before storing new credentials;
  // a fresh sign-in is not a restore, so the route must stay pending
  // (`identityPending`) until `user.getMe` answers.
  const restoredUserId = useRestoredAccountId(owner.authEpoch, owner.restored);
  const sessionQuery = useQuery(
    {
      ...trpc.cliSessionsV2.get.queryOptions(
        { session_id: sessionId ?? '' },
        {
          retry: (failureCount, error) => {
            // One predicate answers for every open: a `NOT_FOUND` repeats
            // within the shared 8×1s budget, whichever screen or link started
            // the open, including an open that began on the identity restored
            // from storage. The account boundary stays immediate because an
            // access denial is `UNAUTHORIZED`/`FORBIDDEN`, which the predicate
            // never retries.
            const errorCode =
              (error as { data?: { code?: string } } | null)?.data?.code ??
              (error as { code?: string } | null)?.code;
            return shouldRetrySessionNotFound({
              attempt: failureCount,
              errorCode,
            });
          },
          // kilocode_change - C3b: TanStack Query's default retryDelay is
          // exponential backoff (1s, 2s, 4s, 8s, ... capped at 30s), which
          // would stretch the 8-attempt ceiling well past the "~8s is
          // generous" budget the spawned-row window actually needs. Pin a
          // flat 1s cadence so 8 attempts stay close to 8 seconds elapsed,
          // matching the plan's stated timing. Only in effect while a retry is
          // allowed at all (a `NOT_FOUND` within the budget) — every other code
          // returns `false` on the first failure, so this delay is never
          // consulted.
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
      // A param the store cannot address as a session id never starts a
      // metadata read: the permanent not-found state below renders instead, so
      // a malformed param cannot fire the read even when the route was opened
      // without an organization. The rule accepts every id shape the store can
      // hold, not only the canonical one, because an older stored session is
      // addressed by the id it was created with.
      enabled:
        isAuthenticatedOwner(owner) &&
        routeOrganizationId === undefined &&
        sessionId !== null &&
        isAddressableStoredSessionId(sessionId),
    }
    // The route renders the session's own subtree; no suspense boundary.
  );

  // Sign-in clears the prior hint before storing new credentials.
  const sessionScopeUserId = owner.userId ?? restoredUserId;
  const identityPending = sessionScopeUserId === null;
  const identityFailed = identityPending && confirmation.isError;
  const providerKey = `${owner.generation}:${sessionScopeUserId}:${sessionId}:${routeOrganizationId ?? 'personal'}`;
  const displayedProviderKey = useRef<string | null>(null);

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

  // A param outside every id shape the store can address can never resolve, so
  // it takes the permanent not-found state below without starting a read or a
  // skeleton. This is only reachable from a hand-built destination: a link that
  // names a session is filtered before it is followed
  // (`deep-link-destination.ts`), and a stored row always carries an id the
  // store issued.
  const addressable = isAddressableStoredSessionId(sessionId);

  // The remote-spawn params mark the opens the spawn itself created for a
  // writer (`kilo remote`, and the clone onto its live CLI). Every other open
  // here has no metadata row yet (this window implies `sessionQuery` has no
  // data) and no resolved kind, so its bottom slot reserves the read-only
  // footer's shape — the bar and the continue control a stored session ends in
  // — rather than painting a composer the session may not get.
  const isPendingWritable = spawned === '1' || cloned === '1';

  if (
    !identityFailed &&
    addressable &&
    (identityPending ||
      (metadataPhase === 'loading' && displayedProviderKey.current !== providerKey))
  ) {
    // The bottom placeholder holds its own height: nothing may shift when
    // the query resolves. Route title hints are not bound to an account.
    // The loading header reserves the loaded header's context pill (the loaded
    // right cluster is that pill plus an optional PR badge) so the swap cannot
    // re-wrap the title. Copying the session link belongs to the context
    // details sheet, which mounts with SessionDetailContent below, so this
    // header deliberately renders no copy control while the session is
    // unresolved.
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('agentChat.session.title')}
          reserveTitleSpace
          titleNumberOfLines={SESSION_HEADER_TITLE_LINES}
          backFallback={AGENTS_SESSIONS_HREF}
          headerRight={
            <View className="min-w-0 shrink flex-row items-center gap-2">
              <SessionContextMetrics
                info={undefined}
                totalCostMicrodollars={null}
                hasMessages={false}
                loading
              />
            </View>
          }
          headerRightShrinks
          className="pb-1"
        />
        <SessionSkeletonMessages sessionId={sessionId} />
        {isPendingWritable ? <SessionComposerSkeleton /> : <SessionReadOnlyFooterPlaceholder />}
      </View>
    );
  }

  const metadataErrorCode = sessionQuery.error?.data?.code;
  const metadataAccessDenied =
    metadataErrorCode === 'NOT_FOUND' ||
    metadataErrorCode === 'UNAUTHORIZED' ||
    metadataErrorCode === 'FORBIDDEN';
  // Arm the rendered-session guard BEFORE the denial branch: a fresh read's
  // data is already in place on the render that also carries a denial (a
  // background refetch failing on the same render its cached data sits
  // beside), and the guard must be armed from that data. A previous mount's
  // cached row carries an earlier `dataUpdatedAt`, so it never arms.
  if (sessionQuery.data != null && sessionQuery.dataUpdatedAt >= openStart.current.startedAt) {
    sessionRendered.current = rawSessionId;
  }
  // A failed background refresh does not invalidate owner-scoped cached
  // metadata. Keep its provider mounted; only an authoritative denial retires it.
  // A retryable metadata failure must not blank a session either: the device may
  // still hold its persisted transcript, so mount the session and let the SDK
  // paint the cached content and surface the retryable failure in place. Only a
  // denial replaces the screen with the error — and only when this open has not
  // rendered the session yet (see the `sessionRendered` ref above), so a
  // background-refetch denial never blanks a rendered session.
  if (
    identityFailed ||
    !addressable ||
    (routeOrganizationId === undefined &&
      sessionQuery.isError &&
      metadataAccessDenied &&
      sessionRendered.current !== rawSessionId)
  ) {
    // An identity failure stays retriable. An authoritative metadata denial
    // (NOT_FOUND / UNAUTHORIZED / FORBIDDEN) and an id the store cannot address
    // can't be recovered by retrying, so they show a permanent state with no
    // Retry. All of them get Back and Copy. A NOT_FOUND reaches this branch only
    // after the open spent its whole retry budget, so the read had its chance to
    // settle before the answer became final.
    displayedProviderKey.current = null;
    // An identity failure owns its own copy. An id the store cannot address
    // never reached a read, so it answers the same denial a missing session
    // does.
    let errorCode = sessionQuery.error?.data?.code;
    if (identityFailed) {
      errorCode = undefined;
    } else if (!addressable) {
      errorCode = 'NOT_FOUND';
    }
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
          titleNumberOfLines={SESSION_HEADER_TITLE_LINES}
          backFallback={AGENTS_SESSIONS_HREF}
          className="pb-1"
        />
        <SessionPermanentError
          variant={variant}
          title={title}
          message={message}
          retry={notFound || unauthorized ? undefined : retry}
          isRetrying={identityFailed ? confirmation.isPending : sessionQuery.isFetching}
          copyText={copyText}
          restoredRouteOpen={restoredOpen && (notFound || unauthorized)}
        />
      </View>
    );
  }

  const organizationId = routeOrganizationId ?? sessionQuery.data?.organization_id ?? undefined;
  // Same-scope metadata is background work once the transcript has mounted.
  // Confirmation/reconnection must not replace it with the initial skeleton.
  displayedProviderKey.current = providerKey;

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
      key={providerKey}
      organizationId={organizationId}
      restoredUserId={restoredUserId ?? undefined}
      clonedSessionId={cloned === '1' ? (sessionId as KiloSessionId) : undefined}
    >
      <SessionDetailContent
        sessionId={sessionId as KiloSessionId}
        cachedTitle={sessionDisplayTitle(sessionQuery.data?.title)}
        displayScope={displayScope}
        openedVia={via === 'push' ? 'push' : 'app'}
        shareId={shareId}
        autoSend={autoSendParam === '1'}
        spawnedMode={spawnedMode}
        openStartedAt={openStart.current.startedAt}
        resumeAt={resumeAt}
      />
    </AgentSessionProvider>
  );
}
