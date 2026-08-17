import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Alert, Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { LogOut, Smartphone } from '@/components/ui/icons';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import {
  classifyDeviceSessionsState,
  type DeviceSession,
  deviceSessionLabel,
  mapRevokeOutcome,
  type RevokeOutcome,
  sortDeviceSessions,
} from '@/lib/device-sessions';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';
import { formatDate, parseTimestamp } from '@/lib/utils';

type SessionRowProps = {
  session: DeviceSession;
  disabled: boolean;
  onPress: (session: DeviceSession) => void;
};

function SessionRow({ session, disabled, onPress }: SessionRowProps) {
  const colors = useThemeColors();

  return (
    <View className="flex-row items-start gap-3 rounded-lg bg-secondary p-3">
      <Smartphone size={18} color={colors.secondaryForeground} />
      <View className="min-w-0 flex-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-sm font-medium" numberOfLines={1}>
            {deviceSessionLabel(session.user_agent)}
          </Text>
          {session.isCurrent && (
            <View className="rounded-full bg-primary px-2 py-0.5">
              <Text className="text-[10px] font-semibold uppercase leading-[normal] text-primary-foreground">
                This device
              </Text>
            </View>
          )}
        </View>
        <Text variant="muted" className="mt-0.5 text-xs">
          Signed in {formatDate(parseTimestamp(session.created_at))} · Last seen{' '}
          {formatDate(parseTimestamp(session.last_seen_at))}
        </Text>
      </View>
      <Pressable
        onPress={() => {
          onPress(session);
        }}
        disabled={disabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={session.isCurrent ? 'Sign out this device' : 'Sign out this session'}
        className="shrink-0 active:opacity-70"
      >
        <LogOut size={16} color={colors.destructive} />
      </Pressable>
    </View>
  );
}

export function DeviceSessionsScreen() {
  const router = useRouter();
  const { signOut, token } = useAuth();
  const trpc = useTRPC();

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    ...trpc.user.listDeviceSessions.queryOptions(),
    enabled: token != null,
  });

  const state = classifyDeviceSessionsState({ isLoading, isError, data });
  const sessions = sortDeviceSessions(data ?? []);

  // Shared outcome sink for the revoke mutation. `mapRevokeOutcome` decides
  // the toast type and whether the authoritative list refetches; only the
  // generic error keeps the row without a refetch.
  const applyRevokeOutcome = (outcome: RevokeOutcome) => {
    if (outcome.toast === 'success') {
      toast.success(outcome.message);
    } else if (outcome.toast === 'info') {
      toast.info(outcome.message);
    } else {
      toast.error(outcome.message);
    }
    if (outcome.refetch) {
      void refetch();
    }
  };

  const revokeSession = useMutation(
    trpc.user.revokeDeviceSessionById.mutationOptions({
      onSuccess: result => {
        applyRevokeOutcome(mapRevokeOutcome(result, undefined));
      },
      onError: error => {
        applyRevokeOutcome(
          mapRevokeOutcome(undefined, { message: error.message, code: error.data?.code })
        );
      },
    })
  );

  const confirmSessionAction = (session: DeviceSession) => {
    if (session.isCurrent) {
      // The current device signs out through the normal signOut() flow so the
      // full local teardown (tokens, metadata, cache) stays truthful.
      Alert.alert(
        'Sign out this device?',
        'You will need to sign in again to access your workspace.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Sign out',
            style: 'destructive',
            onPress: () => {
              void signOut();
            },
          },
        ]
      );
      return;
    }
    Alert.alert(
      'Sign out this session?',
      `${deviceSessionLabel(session.user_agent)} will be signed out on that device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            revokeSession.mutate({ sessionId: session.id });
          },
        },
      ]
    );
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Device sessions" />
      <DetailScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {state === 'loading' && (
          <View className="gap-3">
            {[0, 1, 2].map(index => (
              <View key={index} className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
                <Skeleton className="h-[18px] w-[18px] rounded" />
                <View className="flex-1 gap-1.5">
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-4 w-48" />
                </View>
                <Skeleton className="h-4 w-4 rounded" />
              </View>
            ))}
          </View>
        )}

        {state === 'error' && (
          <QueryError
            variant="server"
            placement="top"
            title="Could not load sessions"
            message="Your active sessions are unavailable until this loads."
            onRetry={() => void refetch()}
            isRetrying={isFetching}
          />
        )}

        {state === 'empty' && (
          <EmptyState
            icon={Smartphone}
            placement="top"
            title="No active sessions"
            description="Sign in on another device and it will show up here."
            action={
              <Button
                variant="outline"
                onPress={() => {
                  router.back();
                }}
              >
                <Text>View profile</Text>
              </Button>
            }
          />
        )}

        {(state === 'happy' || state === 'no-current') && (
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
                Current device could not be identified
              </Text>
            )}
          </View>
        )}
      </DetailScreenScrollView>
    </View>
  );
}
