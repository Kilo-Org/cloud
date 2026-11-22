import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState, StateAction } from '@/components/empty-state';
import { DirectionalArrowLeft, DirectionalLogOut } from '@/components/ui/directional-icons';
import { Globe, Smartphone, Terminal } from '@/components/ui/icons';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { useConfirmDialog } from '@/components/ui/dialog';
import { RefreshControl } from '@/components/ui/refresh-control';
import { RefreshProgress } from '@/components/ui/refresh-progress';
import { RowGroup } from '@/components/ui/row-group';
import { RowIconAction } from '@/components/ui/row-trailing';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { isolateBidiText } from '@/lib/bidi';
import {
  classifyDeviceSessionsState,
  type DeviceSession,
  deviceSessionLabel,
  sortDeviceSessions,
} from '@/lib/device-sessions';
import { formatDate } from '@/lib/format';
import { useManualRefresh } from '@/lib/hooks/use-manual-refresh';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

type SessionRowProps = {
  session: DeviceSession;
  disabled: boolean;
  onPress: (session: DeviceSession) => void;
};

/**
 * The leading tile of each client kind the server classifies: a phone for the
 * app, a terminal for the CLI and a globe for a browser session.
 */
const SESSION_ICON = {
  app: Smartphone,
  cli: Terminal,
  browser: Globe,
  other: Smartphone,
} as const;

function sessionIcon(session: DeviceSession): (typeof SESSION_ICON)[keyof typeof SESSION_ICON] {
  if (session.kind === 'cli') {
    return SESSION_ICON.cli;
  }
  if (session.kind === 'browser') {
    return SESSION_ICON.browser;
  }
  return SESSION_ICON.app;
}

function SessionRow({ session, disabled, onPress }: SessionRowProps) {
  const colors = useThemeColors();
  const { t, i18n } = useTranslation();
  const device = deviceSessionLabel(session);
  const signedIn = formatDate(parseTimestamp(session.created_at), i18n.language);
  const lastSeen = formatDate(parseTimestamp(session.last_seen_at), i18n.language);

  return (
    <ConfigureRow
      icon={sessionIcon(session)}
      title={device}
      subtitle={
        session.isCurrent
          ? t('deviceSessions.signedInThisDevice', {
              signedIn,
              thisDevice: t('deviceSessions.thisDevice'),
            })
          : t('deviceSessions.signedIn', { signedIn, lastSeen })
      }
      // The dates are one sentence, so a narrow row ends it with an ellipsis
      // instead of breaking "Last seen" away from its date.
      subtitleNumberOfLines={2}
      variant="action"
      trailing={
        <RowIconAction
          label={
            session.isCurrent
              ? t('deviceSessions.signOutThisDevice')
              : t('deviceSessions.signOutSessionLabel', {
                  device: isolateBidiText(device),
                  signedIn,
                  lastSeen,
                })
          }
          disabled={disabled}
          onPress={() => {
            onPress(session);
          }}
        >
          {/* The row keeps the muted ink: a red icon on every row outshouted the
              session names, and the confirm dialog is where the action turns
              destructive. */}
          <DirectionalLogOut size={16} color={colors.mutedForeground} />
        </RowIconAction>
      }
    />
  );
}

export function DeviceSessionsScreen() {
  const router = useRouter();
  const { signOut, token } = useAuth();
  const trpc = useTRPC();
  const { t, i18n } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();

  const { data, isPending, isError, isFetching, refetch } = useQuery({
    ...trpc.user.listDeviceSessions.queryOptions(),
    enabled: token != null,
  });

  const state = classifyDeviceSessionsState({
    // `isPending`, not `isLoading`: React Query v5's `isLoading` is
    // `isPending && isFetching`, so it is false on the first render before the
    // fetch starts and the cold open would classify as `empty`.
    isPending,
    isError: isError && data === undefined,
    data,
  });
  const sessions = sortDeviceSessions(data ?? []);
  // A session revoked elsewhere leaves this list stale until it refetches, so
  // a pull asks the server again.
  const [refreshing, onRefresh] = useManualRefresh(refetch, t('common.couldNotRefresh'));
  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />;

  const revokeSession = useMutation(
    trpc.user.revokeDeviceSessionById.mutationOptions({
      onSuccess: () => {
        toast.success(t('deviceSessions.sessionSignedOut'));
        void refetch();
      },
      onError: () => {
        toast.error(t('deviceSessions.sessionSignOutFailed'));
      },
    })
  );

  const confirmSessionAction = (session: DeviceSession) => {
    if (session.isCurrent) {
      // The current device signs out through the normal signOut() flow so the
      // full local teardown (tokens, metadata, cache) stays truthful.
      confirm({
        title: t('deviceSessions.signOutThisDeviceTitle'),
        message: t('profile.signOutMessage'),
        confirmLabel: t('common.signOut'),
        onConfirm: () => {
          void signOut();
        },
      });
      return;
    }
    confirm({
      title: t('deviceSessions.signOutThisSessionTitle'),
      message: t('deviceSessions.signOutThisSessionMessage', {
        device: isolateBidiText(deviceSessionLabel(session)),
        lastSeen: formatDate(parseTimestamp(session.last_seen_at), i18n.language),
      }),
      confirmLabel: t('common.signOut'),
      onConfirm: () => {
        revokeSession.mutate({ sessionId: session.id });
      },
    });
  };

  let body: ReactNode = null;
  if (state === 'error') {
    body = (
      <QueryError
        variant="server"
        title={t('common.couldNotLoadSessions')}
        message={t('deviceSessions.couldNotLoadDescription')}
        onRetry={() => void refetch()}
        isRetrying={isFetching}
      />
    );
  } else if (state === 'empty') {
    body = (
      <EmptyState
        icon={Smartphone}
        title={t('deviceSessions.noSessions')}
        description={t('deviceSessions.noSessionsDescription')}
        action={
          <StateAction
            label={t('deviceSessions.viewProfile')}
            icon={DirectionalArrowLeft}
            onPress={() => {
              router.back();
            }}
          />
        }
      />
    );
  } else {
    body = (
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
        refreshControl={refreshControl}
      >
        {state === 'loading' ? (
          <RowGroup leadingTile>
            {[0, 1, 2].map(index => (
              <RowSkeleton key={index} tile subtitle trailingControl />
            ))}
          </RowGroup>
        ) : (
          <Section>
            <RowGroup leadingTile>
              {sessions.map(session => (
                <SessionRow
                  key={session.id}
                  session={session}
                  disabled={revokeSession.isPending}
                  onPress={confirmSessionAction}
                />
              ))}
            </RowGroup>
            {state === 'no-current' && (
              <Text variant="caption" className="text-center">
                {t('deviceSessions.currentDeviceUnidentified')}
              </Text>
            )}
            <Text variant="caption">{t('deviceSessions.signInScopeNote')}</Text>
          </Section>
        )}
      </TabScreenScrollView>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.deviceSessions')} backFallback={PROFILE_TAB_HREF} />
      {/* The pull's reduced-motion band sits above the scroller, never inside
          it: the scroller's content container carries `SCREEN_BODY_CLASS`, whose
          `gap-6` would push the first row down even with motion on, and a band
          in flow would also scroll away with the rows. This column has no gap,
          so under motion the band's empty box changes nothing. The error and
          empty branches render no pull, and keep no band. */}
      {state !== 'error' && state !== 'empty' ? (
        <RefreshProgress refreshControl={refreshControl} />
      ) : null}
      {body}
      {dialog}
    </View>
  );
}
