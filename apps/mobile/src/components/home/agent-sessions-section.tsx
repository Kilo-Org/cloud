import { type Href, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, type ScrollViewProps, View } from 'react-native';

import { CenteredState } from '@/components/centered-state';

import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { SectionHeader } from '@/components/home/section-header';
import { QueryError, type QueryErrorVariant } from '@/components/query-error';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useStatusAnnouncement } from '@/lib/a11y/status-announcement';
import { useAuth } from '@/lib/auth/auth-context';
import { type useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useUserWebConnectionHealth } from '@/lib/hooks/use-user-web-connection-state';
import { useOrganization } from '@/lib/organization-context';
import { createSubmitLock } from '@/lib/submit-lock';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { cn } from '@/lib/utils';

// The trailing slash pins the index route.
const AGENTS_INDEX_HREF = '/(app)/(tabs)/(2_agents)/' as const;
const MAX_ROWS = 3;
type LiveSessions = ReturnType<typeof useLiveAgentSessions>;
type LiveSessionContext = Omit<ReturnType<typeof useLiveSessionContext>, 'accountReady'>;

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
    organizationId === null ? t('profile.personal') : boundary.org?.organizationName;
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
  return sessions.hasAcceptedSuccess ? 'empty' : 'pending';
}

type LiveSessionProps = Readonly<{ context: LiveSessionContext; sessions: LiveSessions }>;

/** Notices stay outside the rows so refresh and connection changes cannot remount them. */
export function LiveSessionFeedback({
  context,
  sessions,
  failureLabel,
  centered = false,
  refreshControl,
}: LiveSessionProps & {
  failureLabel: string;
  centered?: boolean;
  refreshControl?: ScrollViewProps['refreshControl'];
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const internet = useCommittedConnectivityStatus();
  const { isConnected, reconnectExhausted } = useUserWebConnectionHealth();
  const connection = useUserWebConnection();
  const wasConnected = useRef(false);
  useEffect(() => {
    wasConnected.current ||= isConnected;
  }, [isConnected]);
  const retryLock = useMemo(createSubmitLock, []);
  const [retrying, setRetrying] = useState(false);
  const handleRetry = () => {
    if (!retryLock.acquire()) {
      return;
    }
    setRetrying(true);
    void (async () => {
      try {
        await (context.isError ? context.refetch() : sessions.refetch());
      } finally {
        retryLock.release();
        setRetrying(false);
      }
    })();
  };
  const content = liveSessionContent(context, sessions);
  useStatusAnnouncement(
    context.isReady && sessions.terminalError?.kind === 'retryable' ? failureLabel : null
  );
  const denied = context.isReady && sessions.terminalError?.kind === 'non-retryable';
  const unavailable = !context.isResolving && !context.isReady && !context.isError;
  let failure: ReactNode = null;
  if (context.isError) {
    failure = (
      <QueryError
        placement="top"
        className={centered ? 'pt-0' : undefined}
        title={t('organization.boundary.loadErrorTitle')}
        message={t('organization.boundary.loadErrorMessage')}
        onRetry={handleRetry}
        isRetrying={retrying}
      />
    );
  } else if (unavailable || denied) {
    const code = readTrpcErrorField(sessions.terminalError?.error, 'code');
    let variant: QueryErrorVariant = 'permission';
    let title: string | undefined = undefined;
    let message: string | undefined = undefined;
    if (unavailable && context.organizationId !== null) {
      title = t('organization.boundary.organizationUnavailable');
      message = t('organization.boundary.unavailableDescription');
    } else if (denied && code === 'NOT_FOUND') {
      variant = 'not-found';
    } else if (denied && code !== 'FORBIDDEN' && code !== 'UNAUTHORIZED') {
      variant = 'neutral';
      title = t('home.couldNotLoadSessions');
      message = failureLabel;
    }
    failure = (
      <>
        <QueryError
          placement="top"
          className={centered ? 'pt-0' : undefined}
          variant={variant}
          title={title}
          message={message}
        />
        <Button
          variant="outline"
          accessibilityLabel={t('organization.boundary.backToProfile')}
          onPress={() => {
            router.replace('/(app)/(tabs)/(3_profile)' as Href);
          }}
        >
          <Text>{t('organization.boundary.backToProfile')}</Text>
        </Button>
      </>
    );
  } else if (context.isReady && sessions.terminalError) {
    const compact = content === 'rows';
    failure = (
      <View className="gap-1">
        {!compact && (
          <QueryError placement="top" className={centered ? 'pt-0' : undefined} message="" />
        )}
        <View className={cn('items-center', compact ? 'flex-row gap-2' : 'gap-4')}>
          <Text
            accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
            className={cn('text-destructive', compact ? 'flex-1 text-xs' : 'text-center text-sm')}
          >
            {failureLabel}
          </Text>
          <Button
            variant={compact ? 'ghost' : 'outline'}
            size={compact ? 'sm' : 'default'}
            onPress={handleRetry}
            loading={retrying}
            accessibilityLabel={t('common.retry')}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      </View>
    );
  }
  let connectionLabel: string | null = null;
  if (context.isReady && !isConnected && internet !== 'offline') {
    if (reconnectExhausted) {
      connectionLabel = t('agentChat.sessionConnection.connectionLost');
    } else if (!sessions.isPaused) {
      connectionLabel = wasConnected.current
        ? t('agentChat.sessionConnection.reconnecting')
        : t('agentChat.sessionConnection.connecting');
    }
  }

  const feedback = (
    <View className={cn('gap-2', centered && 'px-6')}>
      <View className="flex-row items-center gap-2">
        {/* The app-wide OfflineBanner owns the offline announcement. */}
        {internet === 'offline' ? (
          <Text className="flex-1 text-xs text-muted-foreground">{t('offline.noInternet')}</Text>
        ) : (
          <AccessibleStatus
            message={connectionLabel}
            tone="status"
            className={cn(
              'flex-1 text-xs',
              !reconnectExhausted && 'absolute size-px overflow-hidden'
            )}
          />
        )}
        {context.isReady && !isConnected && reconnectExhausted && (
          <Button
            variant="ghost"
            size="sm"
            accessibilityLabel={t('agentChat.sessionConnection.retryConnection')}
            onPress={() => {
              connection.retryConnection();
            }}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        )}
      </View>
      <AccessibleStatus
        message={content === 'pending' ? t('agentChat.instancePicker.loading') : null}
        tone="status"
        className="absolute size-px overflow-hidden"
      />
      {content === 'rows' && sessions.isFetching && !sessions.isPaused && (
        <AccessibleStatus
          message={t('agents.sessionList.updating')}
          tone="status"
          className="absolute size-px overflow-hidden"
        />
      )}
      {failure}
    </View>
  );
  return centered ? (
    <CenteredState refreshControl={refreshControl}>{feedback}</CenteredState>
  ) : (
    feedback
  );
}

export function AgentSessionsSection({ context, sessions }: LiveSessionProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const navigateToSession = useAgentSessionNavigator();
  const content = liveSessionContent(context, sessions);

  return (
    <View>
      <SectionHeader
        label={t('home.agentSessions')}
        actionLabel={t('home.seeAll')}
        onActionPress={() => {
          // Switch tabs, then pop a previously pushed history screen to the live index.
          router.navigate(AGENTS_INDEX_HREF as Href);
          router.dismissTo(AGENTS_INDEX_HREF as Href);
        }}
      />
      <View className="mx-4 gap-2">
        <LiveSessionFeedback
          context={context}
          sessions={sessions}
          failureLabel={t('home.couldNotLoadActiveSessions')}
        />
        {content === 'pending' && <Skeleton className="min-h-[72px] w-full rounded-2xl" />}
        {content === 'empty' && (
          <View className="min-h-[72px] items-center justify-center rounded-2xl border border-border bg-card px-4">
            <Text variant="muted" className="text-sm">
              {t('home.noLiveSessions')}
            </Text>
          </View>
        )}
        {content === 'rows' &&
          sessions.activeSessions.slice(0, MAX_ROWS).map(session => (
            <View
              key={`active:${session.id}`}
              className="min-h-[72px] overflow-hidden rounded-2xl border border-border bg-card"
            >
              <RemoteSessionRow
                session={session}
                variant="card"
                interactive={false}
                onPress={() => {
                  navigateToSession(session.id);
                }}
              />
            </View>
          ))}
      </View>
    </View>
  );
}
