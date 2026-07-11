import { PackageSearch } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Alert, FlatList, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useLocalSearchParams } from 'expo-router';

import { EmptyState } from '@/components/empty-state';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { type VersionItem, VersionPinRow } from '@/components/kiloclaw/version-pin-row';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useInstanceContext } from '@/lib/hooks/use-instance-context';
import {
  useKiloClawAvailableVersions,
  useKiloClawLatestVersion,
  useKiloClawMutations,
  useKiloClawMyPin,
} from '@/lib/hooks/use-kiloclaw-queries';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

const PAGE_SIZE = 25;

export default function VersionPinScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId =
    instanceContext.status === 'ready' ? instanceContext.organizationId : undefined;
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
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Version Pinning" />
        <InstanceContextBoundary context={instanceContext} />
      </View>
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Version Pinning" />
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

  if (myPinQuery.isError || latestVersionQuery.isError || availableVersionsQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Version Pinning" />
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
  const hasMoreVersions = pagination != null && versions.length < pagination.totalCount;
  const isFetchingMoreVersions =
    availableVersionsQuery.isFetching && !availableVersionsQuery.isPending;

  const isPinnedByAdmin = myPin != null && !myPin.pinnedBySelf;

  function handleUnpin() {
    Alert.alert('Unpin Version', 'Switch back to the latest available version?', [
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

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Version Pinning" />
      <FlatList
        ref={flatListRef}
        data={versions}
        keyExtractor={item => item.image_tag}
        renderItem={renderVersionItem}
        contentContainerClassName="px-4 pt-4 gap-4"
        contentContainerStyle={{ paddingBottom }}
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <Animated.View entering={FadeIn.duration(200)} className="gap-4 mb-2">
            <View className="rounded-lg bg-secondary p-4 min-h-[60px] justify-center gap-2">
              {myPin ? (
                <>
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1 gap-1">
                      <Text className="text-sm font-medium">
                        Pinned to {myPin.openclaw_version ?? myPin.image_tag}
                      </Text>
                      {myPin.reason && (
                        <Text variant="muted" className="text-xs">
                          {myPin.reason}
                        </Text>
                      )}
                    </View>
                    {!isPinnedByAdmin && (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={mutations.removeMyPin.isPending}
                        disabled={isPinMutating}
                        onPress={handleUnpin}
                      >
                        <Text>Unpin</Text>
                      </Button>
                    )}
                  </View>
                  {isPinnedByAdmin && (
                    <Text className="text-xs text-amber-600 dark:text-amber-400">
                      Pinned by admin — contact your admin to change.
                    </Text>
                  )}
                </>
              ) : (
                <View className="flex-row items-center gap-2">
                  <View className="rounded-full bg-green-200 dark:bg-green-900 px-2 py-0.5">
                    <Text className="text-xs font-medium text-green-800 dark:text-green-100">
                      Following latest
                    </Text>
                  </View>
                  {latestVersion && (
                    <Text variant="muted" className="text-xs">
                      {latestVersion.openclawVersion}
                    </Text>
                  )}
                </View>
              )}
            </View>

            {versions.length > 0 && (
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Available Versions
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
          hasMoreVersions ? (
            <View className="items-center pt-3">
              <Button
                variant="outline"
                size="sm"
                loading={isFetchingMoreVersions}
                onPress={() => {
                  setLimit(l => l + PAGE_SIZE);
                }}
              >
                <Text>Load more versions</Text>
              </Button>
            </View>
          ) : null
        }
        className="rounded-lg bg-secondary"
      />
    </Animated.View>
  );
}
