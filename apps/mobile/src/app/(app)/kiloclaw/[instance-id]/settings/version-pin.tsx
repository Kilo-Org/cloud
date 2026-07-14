import { PackageSearch } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Alert, FlatList, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useLocalSearchParams } from 'expo-router';

import { EmptyState } from '@/components/empty-state';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { type VersionItem, VersionPinRow } from '@/components/kiloclaw/version-pin-row';
import { VersionPinStatusCard } from '@/components/kiloclaw/version-pin-status-card';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { instanceOrgId, useInstanceContext } from '@/lib/hooks/use-instance-context';
import {
  useKiloClawAvailableVersions,
  useKiloClawLatestVersion,
  useKiloClawMutations,
  useKiloClawMyPin,
} from '@/lib/hooks/use-kiloclaw-queries';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

const PAGE_SIZE = 25;
// Server caps `limit` at 100 (kiloclaw-router.ts listAvailableVersions) — never send more.
const MAX_LIMIT = 100;

export default function VersionPinScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId = instanceOrgId(instanceContext);
  const myPinQuery = useKiloClawMyPin(organizationId);
  const latestVersionQuery = useKiloClawLatestVersion();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const availableVersionsQuery = useKiloClawAvailableVersions(organizationId, 0, limit);
  const mutations = useKiloClawMutations(organizationId);
  const paddingBottom = useDetailScreenBottomPadding();
  const pendingReasonRef = useRef('');
  const [pendingItem, setPendingItem] = useState<VersionItem>();
  const flatListRef = useRef<FlatList<VersionItem>>(null);

  const isLoading = myPinQuery.isPending || latestVersionQuery.isPending;
  // Only one pin/unpin mutation should ever be in flight at a time — while
  // either is pending, every pin control is disabled so they can't race.
  const isPinMutating = mutations.setMyPin.isPending || mutations.removeMyPin.isPending;

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return <InstanceContextBoundary title="Version pinning" context={instanceContext} />;
  }

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Version pinning" />
        <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4 gap-3">
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-16 w-full rounded-lg" />
          </Animated.View>
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-12 w-full rounded-lg" />
          </Animated.View>
        </Animated.View>
      </View>
    );
  }

  // Only a genuine initial-load failure (no cached data yet) is a hard
  // error. A background refetch failure (e.g. a failed Load More page)
  // must not blank out already-rendered versions or pin status. Compare
  // against undefined: getMyPin legitimately resolves to null (unpinned).
  if (
    (myPinQuery.isError && myPinQuery.data === undefined) ||
    (latestVersionQuery.isError && latestVersionQuery.data === undefined) ||
    (availableVersionsQuery.isError && availableVersionsQuery.data === undefined)
  ) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Version pinning" />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message="Could not load version information"
            onRetry={() => {
              void myPinQuery.refetch();
              void latestVersionQuery.refetch();
              void availableVersionsQuery.refetch();
            }}
          />
        </View>
      </View>
    );
  }

  const myPin = myPinQuery.data;
  const latestVersion = latestVersionQuery.data;
  const versions = availableVersionsQuery.data?.items ?? [];
  const pagination = availableVersionsQuery.data?.pagination;
  const isAtLimitCap = limit >= MAX_LIMIT;
  const hasMoreVersions = pagination != null && versions.length < pagination.totalCount;
  const versionsPageFailed = availableVersionsQuery.isError && versions.length > 0;
  const isFetchingMoreVersions =
    availableVersionsQuery.isFetching && !availableVersionsQuery.isPending;

  const isPinnedByAdmin = myPin != null && !myPin.pinnedBySelf;

  function handleUnpin() {
    Alert.alert('Unpin version', 'Switch back to the latest available version?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unpin',
        style: 'destructive',
        onPress: () => {
          mutations.removeMyPin.mutate(undefined);
        },
      },
    ]);
  }

  function handlePin(item: VersionItem) {
    setPendingItem(item);
    pendingReasonRef.current = '';
  }

  function scrollToPendingItem() {
    if (!pendingItem) {
      return;
    }
    const index = versions.findIndex(v => v.image_tag === pendingItem.image_tag);
    if (index !== -1) {
      setTimeout(() => {
        flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
      }, 300);
    }
  }

  function confirmPin() {
    if (!pendingItem) {
      return;
    }
    const reason = pendingReasonRef.current.trim() || undefined;
    mutations.setMyPin.mutate(
      { imageTag: pendingItem.image_tag, reason },
      {
        onSuccess: () => {
          setPendingItem(undefined);
          pendingReasonRef.current = '';
        },
      }
    );
  }

  function cancelPin() {
    setPendingItem(undefined);
    pendingReasonRef.current = '';
  }

  function renderVersionItem({ item }: { item: VersionItem }) {
    const isPinned = myPin?.image_tag === item.image_tag;
    const isLatest = latestVersion?.imageTag === item.image_tag;
    const isDraftOpen = pendingItem?.image_tag === item.image_tag;
    const isConfirmingThis = isDraftOpen && mutations.setMyPin.isPending;

    return (
      <VersionPinRow
        item={item}
        isPinned={isPinned}
        isLatest={isLatest}
        isDraftOpen={isDraftOpen}
        isPinMutating={isPinMutating}
        isConfirmingThis={isConfirmingThis}
        isPinnedByAdmin={isPinnedByAdmin}
        adminPinLabel={myPin ? (myPin.openclaw_version ?? myPin.image_tag) : null}
        onToggle={() => {
          if (isDraftOpen) {
            cancelPin();
          } else {
            handlePin(item);
          }
        }}
        onFocusReason={scrollToPendingItem}
        onReasonChange={val => {
          pendingReasonRef.current = val;
        }}
        onConfirm={confirmPin}
      />
    );
  }

  function renderFooter() {
    if (versionsPageFailed) {
      return (
        <View className="items-center gap-2 pt-3">
          <Text variant="muted" className="text-xs">
            Could not load more versions
          </Text>
          <Button
            variant="outline"
            size="sm"
            loading={isFetchingMoreVersions}
            onPress={() => {
              void availableVersionsQuery.refetch();
            }}
          >
            <Text>Retry</Text>
          </Button>
        </View>
      );
    }
    if (hasMoreVersions && !isAtLimitCap) {
      return (
        <View className="items-center pt-3">
          <Button
            variant="outline"
            size="sm"
            loading={isFetchingMoreVersions}
            onPress={() => {
              setLimit(l => Math.min(l + PAGE_SIZE, MAX_LIMIT));
            }}
          >
            <Text>Load more versions</Text>
          </Button>
        </View>
      );
    }
    if (hasMoreVersions && isAtLimitCap) {
      return (
        <View className="items-center pt-3">
          <Text variant="muted" className="text-xs">
            Showing latest 100 versions
          </Text>
        </View>
      );
    }
    return null;
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Version pinning" />
      <FlatList
        ref={flatListRef}
        data={versions}
        keyExtractor={item => item.image_tag}
        renderItem={renderVersionItem}
        contentContainerClassName="px-4 pt-4 gap-4"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <Animated.View entering={FadeIn.duration(200)} className="gap-4 mb-2">
            <VersionPinStatusCard
              myPin={myPin}
              latestVersion={latestVersion}
              isPinnedByAdmin={isPinnedByAdmin}
              isPinMutating={isPinMutating}
              isRemovingPin={mutations.removeMyPin.isPending}
              onUnpin={handleUnpin}
            />

            {versions.length > 0 && (
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Available versions
              </Text>
            )}
          </Animated.View>
        }
        ItemSeparatorComponent={() => <View className="h-px bg-border" />}
        ListEmptyComponent={
          availableVersionsQuery.isPending ? (
            <Skeleton className="h-12 w-full rounded-lg" />
          ) : (
            <EmptyState
              icon={PackageSearch}
              title="No versions available"
              description="Available OpenClaw versions will appear here."
              className="px-0 pt-4"
              placement="top"
            />
          )
        }
        ListFooterComponent={
          <>
            {renderFooter()}
            <View style={{ height: paddingBottom }} pointerEvents="none" />
          </>
        }
        className="rounded-lg bg-secondary"
      />
    </Animated.View>
  );
}
