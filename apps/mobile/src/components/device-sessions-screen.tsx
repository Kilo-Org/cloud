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
import { useConfirmDialog } from '@/components/ui/dialog';
import { IconTile } from '@/components/ui/icon-tile';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
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
  const device = deviceSessionLabel(session.user_agent);
  const signedIn = formatDate(parseTimestamp(session.created_at), i18n.language);
  const lastSeen = formatDate(parseTimestamp(session.last_seen_at), i18n.language);

  return (
    <View className="flex-row items-center gap-3 rounded-lg bg-secondary px-4 py-3">
      <IconTile icon={Smartphone} tint={NEUTRAL_TINT} />
      <View className="min-w-0 flex-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-sm font-medium" numberOfLines={1}>
            {device}
          </Text>
          {session.isCurrent && (
            /* The badge keeps the light olive in dark mode: the dark accent
                (#ffdd00) as a full pill glares and pulls focus, so dark swaps
                in `--selection`, the same hue lifted to stand off the page,
                with its own label tone. */
            <View className="rounded-full bg-primary px-2 py-0.5 dark:bg-selection">
              <Text className="text-[10px] font-semibold uppercase leading-[normal] text-primary-foreground dark:text-selection-foreground">
                {t('deviceSessions.thisDevice')}
              </Text>
            </View>
          )}
        </View>
        <Text variant="muted" className="mt-0.5 text-xs">
          {t('deviceSessions.signedIn', { signedIn, lastSeen })}
        </Text>
      </View>
      {/* The control box hugs its 16 pt glyph: a 44 dp box centred the glyph,
          14 dp inside the card's 10.5 dp padding, while the leading tile sat
          on that padding and the card read lopsided. At 28 dp the glyph's
          outer edge is 6 dp inside the card's 14 dp padding, and 9 dp of hit
          slop per side reaches 46 dp, so pixel rounding cannot drop the target
          under 44 dp. */}
      <Pressable
        onPress={() => {
          onPress(session);
        }}
        disabled={disabled}
        hitSlop={9}
        accessibilityRole="button"
        accessibilityLabel={
          session.isCurrent
            ? t('deviceSessions.signOutThisDevice')
            : t('deviceSessions.signOutSessionLabel', {
                device: isolateBidiText(device),
                signedIn,
                lastSeen,
              })
        }
        className="min-h-[28px] min-w-[28px] shrink-0 items-center justify-center active:opacity-70"
      >
        <DirectionalLogOut size={16} color={colors.destructive} />
      </Pressable>
    </View>
  );
}

export function DeviceSessionsScreen() {
  const router = useRouter();
  const { signOut, token } = useAuth();
  const trpc = useTRPC();
  const { t } = useTranslation();
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
      onError: error => {
        toast.error(error.message);
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
        device: isolateBidiText(deviceSessionLabel(session.user_agent)),
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
        contentContainerClassName="gap-6 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {state === 'loading' ? (
          <View className="gap-3">
            {[0, 1, 2].map(index => (
              <View
                key={index}
                className="flex-row items-center gap-3 rounded-lg bg-secondary px-4 py-3"
              >
                {/* The leading cell reserves the loaded row's 30 dp IconTile
                    frame, so the title starts at the same x and the row keeps
                    the same height when the sessions arrive. */}
                <Skeleton className="h-[30px] w-[30px] shrink-0 rounded-lg" />
                <View className="flex-1 gap-1.5">
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-4 w-48" />
                </View>
                {/* Reserve the sign-out control's final 28x28pt box so the
                    loaded row is the same height as its skeleton and the list
                    does not jump when sessions arrive. The glyph stays 16pt. */}
                <View className="min-h-[28px] min-w-[28px] items-center justify-center">
                  <Skeleton className="h-4 w-4 rounded" />
                </View>
              </View>
            ))}
          </View>
        ) : (
          <View className="gap-3">
            {sessions.map(session => (
              <SessionRow
                key={session.id}
                session={session}
                disabled={revokeSession.isPending}
                onPress={confirmSessionAction}
              />
            ))}
            {state === 'no-current' && (
              <Text variant="muted" className="text-center text-xs">
                {t('deviceSessions.currentDeviceUnidentified')}
              </Text>
            )}
            <Text variant="muted" className="text-xs">
              {t('deviceSessions.onlyKiloAppSignIns')}
            </Text>
          </View>
        )}
      </TabScreenScrollView>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.deviceSessions')} />
      {body}
      {dialog}
    </View>
  );
}
