import { useTranslation } from 'react-i18next';

import { useAuth } from '@/lib/auth/auth-context';
import { type useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useOrganization } from '@/lib/organization-context';

export type LiveSessions = ReturnType<typeof useLiveAgentSessions>;
export type LiveSessionContext = Omit<ReturnType<typeof useLiveSessionContext>, 'accountReady'>;

/** Both live surfaces use the same admission rules, independent of session queries. */
export function useLiveSessionContext() {
  const { t } = useTranslation();
  const { token, isLoading, isSigningOut } = useAuth();
  const { organizationId, isLoaded } = useOrganization();
  const boundary = useOrgBoundary();
  const internet = useCommittedConnectivityStatus();
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
    isOffline: internet === 'offline',
    label,
    refetch: boundary.refetch,
  };
}

export function liveSessionContent(context: LiveSessionContext, sessions: LiveSessions) {
  if (context.isResolving) {
    return 'pending';
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
  // Offline cold start: the active query is paused and will not settle until
  // the network returns, so `hasAcceptedSuccess` never flips and the section
  // would spin on the loading placeholder forever, even though the same
  // surface settles on the empty state online. Once connectivity is confirmed
  // offline, settle on empty too; the offline banner owns the "can't reach the
  // server" notice. While connectivity is still unknown the placeholder stays,
  // so the surface never invents an empty result it cannot know.
  if (context.isOffline && sessions.isPaused) {
    return 'empty';
  }
  return sessions.hasAcceptedSuccess ? 'empty' : 'pending';
}
