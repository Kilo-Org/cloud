import { useTranslation } from 'react-i18next';

import { useAuth } from '@/lib/auth/auth-context';
import { type useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { type BannerState } from '@/lib/offline-banner-state';
import { useOrganization } from '@/lib/organization-context';

export type LiveSessions = ReturnType<typeof useLiveAgentSessions>;
export type LiveSessionContext = Omit<ReturnType<typeof useLiveSessionContext>, 'accountReady'>;

/** Both live surfaces use the same admission rules, independent of session queries. */
export function useLiveSessionContext() {
  const { t } = useTranslation();
  const { token, isLoading, isSigningOut } = useAuth();
  const { organizationId, isLoaded } = useOrganization();
  const boundary = useOrgBoundary();
  const accountReady = Boolean(token) && !isLoading && !isSigningOut;
  const isError = accountReady && isLoaded && organizationId !== null && boundary.isError;
  const isResolving =
    isLoading ||
    !isLoaded ||
    (accountReady &&
      organizationId !== null &&
      !boundary.isError &&
      (boundary.isResolving || boundary.orgs === undefined));
  const isReady =
    accountReady &&
    !isResolving &&
    (organizationId === null || (!isError && boundary.org?.organizationId === organizationId));
  const contextLabel =
    organizationId === null ? t('common.personal') : boundary.org?.organizationName;
  const label = isReady ? contextLabel : undefined;
  return {
    organizationId,
    accountReady,
    isReady,
    isResolving,
    isError,
    label,
    refetch: boundary.refetch,
  };
}

/** What a live surface is showing; `offline` is a state, not a load in flight. */
export type LiveSessionContent = 'pending' | 'offline' | 'rows' | 'empty' | 'error';

/**
 * The one classification both live surfaces (Home's card and the Agents list)
 * read.
 *
 * `connectivity` is the committed connectivity the app-wide offline banner
 * paints. Offline is not loading: a paused first read never settles, so
 * naming it `offline` is what lets a surface draw the offline state with Retry
 * instead of the "Loading…" card and skeletons it cannot settle out of. The
 * paused read still resumes by itself when the connection returns, so the
 * state clears without the person pressing anything. Rows and a confirmed empty
 * list stay as they are: they are real answers from before the connection went
 * away, and the banner already speaks for the connection.
 */
export function liveSessionContent(
  context: LiveSessionContext,
  sessions: LiveSessions,
  connectivity: BannerState
): LiveSessionContent {
  // Nothing a surface can start while offline lands, so the gate asks only
  // whether the sessions read is genuinely in flight. The boundary read runs on
  // `networkMode: 'always'`, so counting its fetch would drop the card to a
  // skeleton for every background organizations refetch — an app foreground, a
  // profile focus, or the card's own Retry — and on an organization scope the
  // failed read would then land the surface on the boundary error instead.
  const offlineWaiting = connectivity === 'offline' && !sessions.isFetching;
  if (context.isResolving) {
    return offlineWaiting ? 'offline' : 'pending';
  }
  if (!context.isReady || sessions.terminalError?.kind === 'non-retryable') {
    return 'error';
  }
  if (sessions.activeSessions.length > 0) {
    return 'rows';
  }
  if (sessions.terminalError) {
    return 'error';
  }
  if (sessions.hasAcceptedSuccess) {
    return 'empty';
  }
  return offlineWaiting ? 'offline' : 'pending';
}
