import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { DirectionalLogOut } from '@/components/ui/directional-icons';
import { Smartphone } from '@/components/ui/icons';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { useConfirmDialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useAuth } from '@/lib/auth/auth-context';
import { isolateBidiText } from '@/lib/bidi';
import {
  classifyDeviceSessionsState,
  type DeviceSession,
  deviceSessionLabel,
  sortDeviceSessions,
} from '@/lib/device-sessions';
import { formatDate } from '@/lib/format';
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

function SessionRow({ session, disabled, onPress }: SessionRowProps) {
  const colors = useThemeColors();
  const { t, i18n } = useTranslation();
  const device = deviceSessionLabel(session);
  const signedIn = formatDate(parseTimestamp(session.created_at), i18n.language);
  const lastSeen = formatDate(parseTimestamp(session.last_seen_at), i18n.language);

  return (
    <ConfigureRow
      icon={Smartphone}
      title={device}
      subtitle={t('deviceSessions.signedIn', { signedIn, lastSeen })}
      variant="action"
      trailing={
        <View className="flex-row items-center gap-2">
          {session.isCurrent && (
            /* The badge keeps the light olive in dark mode: the dark accent
                (#ffdd00) as a full pill glares and pulls focus, so dark swaps
                in `--selection`, the same hue lifted to stand off the page,
                with its own label tone. */
            <View className="rounded-full bg-primary px-2 py-0.5 dark:bg-selection">
              <Text
                variant="eyebrow"
                className="text-primary-foreground dark:text-selection-foreground"
              >
                {t('deviceSessions.thisDevice')}
              </Text>
            </View>
          )}
          <IconButton
            disabled={disabled}
            accessibilityLabel={
              session.isCurrent
                ? t('deviceSessions.signOutThisDevice')
                : t('deviceSessions.signOutSessionLabel', {
                    device: isolateBidiText(device),
                    signedIn,
                    lastSeen,
                  })
            }
            onPress={() => {
              onPress(session);
            }}
          >
            <DirectionalLogOut size={16} color={colors.destructive} />
          </IconButton>
        </View>
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
          <Button
            variant="outline"
            className={STATE_ACTION_CLASS}
            onPress={() => {
              router.back();
            }}
          >
            <Text>{t('deviceSessions.viewProfile')}</Text>
          </Button>
        }
      />
    );
  } else {
    body = (
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        {state === 'loading' ? (
          <RowGroup leadingTile>
            {[0, 1, 2].map(index => (
              <RowSkeleton key={index} tile subtitle />
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
      {body}
      {dialog}
    </View>
  );
}
