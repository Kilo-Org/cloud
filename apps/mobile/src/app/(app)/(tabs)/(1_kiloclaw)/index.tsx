import { type Href, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyStateContent } from '@/components/kiloclaw/empty-state-content';
import { getKiloClawEntryDecision } from '@/components/kiloclaw/instance-entry-state';
import { InstanceListScreen } from '@/components/kiloclaw/instance-list-screen';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useForegroundInvalidateKiloclawState } from '@/lib/hooks/use-foreground-invalidate-kiloclaw-state';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { useKiloClawMobileOnboardingState } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useUnreadCounts } from '@/lib/hooks/use-unread-counts';
import { chatSandboxPath } from '@/lib/kilo-chat-routes';
import { getTabBarOverlayHeight } from '@/lib/tab-bar-layout';

export default function KiloClawTab() {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const instancesQuery = useAllKiloClawInstances();
  const { data: instances } = instancesQuery;
  const { byBadgeBucket: unreadByBadgeBucket } = useUnreadCounts();
  const refetchInstances = instancesQuery.refetch;
  const entryDecision = getKiloClawEntryDecision(instances);
  const onboardingQuery = useKiloClawMobileOnboardingState(entryDecision.kind === 'empty');
  useForegroundInvalidateKiloclawState();

  const showInstanceSkeleton = entryDecision.kind === 'loading' || onboardingQuery.isPending;
  const emptyStateContainerStyle = {
    paddingBottom: getTabBarOverlayHeight(bottom, Platform.OS),
  };

  const handleRefresh = useCallback(() => {
    void (async () => {
      setManualRefreshing(true);
      try {
        await refetchInstances();
      } finally {
        setManualRefreshing(false);
      }
    })();
  }, [refetchInstances]);

  const onboardingQueryEnabled = entryDecision.kind === 'empty';
  const hasQueryError =
    instancesQuery.isError || (onboardingQueryEnabled && onboardingQuery.isError);

  if (hasQueryError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title="KiloClaw"
          size="large"
          showBackButton={false}
          className="px-[22px]"
          headerRight={<ProfileAvatarButton />}
        />
        <Animated.View entering={FadeIn.duration(200)} className="flex-1">
          <QueryError
            className="flex-1"
            message="Could not load KiloClaw instances"
            onRetry={() => {
              if (instancesQuery.isError) {
                void instancesQuery.refetch();
              }
              if (onboardingQueryEnabled && onboardingQuery.isError) {
                void onboardingQuery.refetch();
              }
            }}
          />
        </Animated.View>
      </View>
    );
  }

  if (entryDecision.kind === 'list') {
    return (
      <InstanceListScreen
        instances={instances ?? []}
        refreshing={manualRefreshing}
        onRefresh={handleRefresh}
        onSelect={sandboxId => {
          router.push(chatSandboxPath(sandboxId));
        }}
        onSettingsPress={sandboxId => {
          router.push(`/(app)/kiloclaw/${sandboxId}/dashboard` as Href);
        }}
        unreadByBadgeBucket={unreadByBadgeBucket}
        onCreate={() => {
          router.push('/(app)/onboarding' as Href);
        }}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="KiloClaw"
        size="large"
        showBackButton={false}
        className="px-[22px]"
        headerRight={<ProfileAvatarButton />}
      />
      <Animated.View layout={LinearTransition} className="flex-1 px-4">
        {showInstanceSkeleton || onboardingQuery.data === undefined ? (
          <Animated.View exiting={FadeOut.duration(150)} className="w-full gap-3 px-4 pt-5">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </Animated.View>
        ) : (
          <Animated.View
            entering={FadeIn.duration(200)}
            className="flex-1 items-center justify-center"
            style={emptyStateContainerStyle}
          >
            <EmptyStateContent
              foregroundColor={colors.foreground}
              state={onboardingQuery.data}
              onCreate={() => {
                router.push('/(app)/onboarding' as Href);
              }}
            />
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}
