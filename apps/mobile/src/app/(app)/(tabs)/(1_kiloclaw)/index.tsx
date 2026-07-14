import { type Href, useRouter } from 'expo-router';
import { Platform, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  EmptyStateContent,
  resolveAccessRequiredSubcase,
} from '@/components/kiloclaw/empty-state-content';
import { getKiloClawEntryDecision } from '@/components/kiloclaw/instance-entry-state';
import { InstanceListScreen } from '@/components/kiloclaw/instance-list-screen';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useForegroundInvalidateKiloclawState } from '@/lib/hooks/use-foreground-invalidate-kiloclaw-state';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { useKiloClawMobileOnboardingState } from '@/lib/hooks/use-kiloclaw-queries';
import { useManualRefresh } from '@/lib/hooks/use-manual-refresh';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useUnreadCounts } from '@/lib/hooks/use-unread-counts';
import { chatSandboxPath } from '@/lib/kilo-chat-routes';
import { getTabBarOverlayHeight } from '@/lib/tab-bar-layout';

export default function KiloClawTab() {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const instancesQuery = useAllKiloClawInstances();
  const { data: instances } = instancesQuery;
  const { byBadgeBucket: unreadByBadgeBucket } = useUnreadCounts();
  const refetchInstances = instancesQuery.refetch;
  const entryDecision = getKiloClawEntryDecision(instances);
  // Always enabled (not just for the empty-list case) so a personal
  // billing/access issue is still surfaced as a card annotation when the
  // list is non-empty — see `personalAccessIssue` below.
  const onboardingQuery = useKiloClawMobileOnboardingState();
  const personalAccessIssue = onboardingQuery.data
    ? resolveAccessRequiredSubcase(onboardingQuery.data)
    : null;
  useForegroundInvalidateKiloclawState();

  const showInstanceSkeleton = entryDecision.kind === 'loading' || onboardingQuery.isPending;
  const emptyStateContainerStyle = {
    paddingBottom: getTabBarOverlayHeight(bottom, Platform.OS, fontScale),
  };

  const [manualRefreshing, handleRefresh] = useManualRefresh(
    refetchInstances,
    "Couldn't refresh. Pull down to try again."
  );

  // A background billing-check failure while the list is already showing
  // shouldn't blank the screen — only block on it before we have any
  // instances to show (preserve stale/cached data).
  const hasQueryError =
    entryDecision.kind !== 'list' && (instancesQuery.isError || onboardingQuery.isError);

  if (hasQueryError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="KiloClaw" size="large" showBackButton={false} className="px-[22px]" />
        <Animated.View
          entering={FadeIn.duration(200)}
          className="flex-1"
          style={emptyStateContainerStyle}
        >
          <QueryError
            className="flex-1"
            message="Could not load KiloClaw instances"
            onRetry={() => {
              if (instancesQuery.isError) {
                void instancesQuery.refetch();
              }
              if (onboardingQuery.isError) {
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
        personalAccessIssue={personalAccessIssue}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="KiloClaw" size="large" showBackButton={false} className="px-[22px]" />
      <Animated.View layout={LinearTransition} className="flex-1 px-4">
        {showInstanceSkeleton || onboardingQuery.data === undefined ? (
          <Animated.View exiting={FadeOut.duration(150)} className="w-full gap-3 pt-5">
            <Skeleton className="h-[72px] w-full rounded-2xl" />
            <Skeleton className="h-[72px] w-full rounded-2xl" />
            <Skeleton className="h-[72px] w-full rounded-2xl" />
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
