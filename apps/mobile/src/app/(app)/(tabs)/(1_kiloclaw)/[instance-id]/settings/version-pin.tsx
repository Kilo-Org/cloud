import { Check } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Alert, FlatList, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useLocalSearchParams } from 'expo-router';

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
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseTimestamp, timeAgo } from '@/lib/utils';

type VersionItem = NonNullable<
  ReturnType<typeof useKiloClawAvailableVersions>['data']
>['items'][number];

export default function VersionPinScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const { organizationId } = useInstanceContext(instanceId);
  const colors = useThemeColors();
  const myPinQuery = useKiloClawMyPin(organizationId);
  const latestVersionQuery = useKiloClawLatestVersion();
  const availableVersionsQuery = useKiloClawAvailableVersions(organizationId);
  const mutations = useKiloClawMutations(organizationId);
  const pendingReasonRef = useRef('');
  const [pendingItem, setPendingItem] = useState<VersionItem>();
  const flatListRef = useRef<FlatList<VersionItem>>(null);

  const isLoading = myPinQuery.isPending || latestVersionQuery.isPending;

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
    const publishedAgo = item.published_at ? timeAgo(parseTimestamp(item.published_at)) : undefined;
    const isLatest = latestVersion?.imageTag === item.image_tag;
    const showVariant = item.variant && item.variant !== 'default';
    const isPending = pendingItem?.image_tag === item.image_tag;

    return (
      <View>
        <View className="flex-row items-center gap-3 py-3">
          <View className="flex-1 gap-0.5">
            <View className="flex-row items-center gap-2">
              <Text className="text-sm font-medium">{item.openclaw_version}</Text>
              {isLatest && (
                <View className="rounded-full bg-blue-600 px-1.5 py-0.5">
                  <Text className="text-[10px] font-semibold text-white">latest</Text>
                </View>
              )}
            </View>
            {Boolean(publishedAgo ?? showVariant) && (
              <Text variant="muted" className="text-xs">
                {[publishedAgo, showVariant ? item.variant : null].filter(Boolean).join(' · ')}
              </Text>
            )}
          </View>
          {isPinned ? (
            <Check size={18} color={colors.foreground} />
          ) : (
            <Button
              size="sm"
              variant={isPending ? 'default' : 'outline'}
              onPress={() => {
                if (isPending) {
                  cancelPin();
                } else {
                  handlePin(item);
                }
              }}
            >
              <Text>{isPending ? 'Cancel' : 'Pin'}</Text>
            </Button>
          )}
        </View>
        {isPending && (
          <Animated.View entering={FadeIn.duration(150)} className="border-t border-border">
            <View className="py-3 gap-3">
              <Text className="text-xs font-medium text-muted-foreground">Reason (optional)</Text>
              <TextInput
                className="rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground"
                placeholder="Why are you pinning this version?"
                placeholderTextColor={colors.mutedForeground}
                onFocus={scrollToPendingItem}
                onChangeText={val => {
                  if (val.length <= 500) {
                    pendingReasonRef.current = val;
                  }
                }}
                autoCapitalize="sentences"
                autoCorrect
                multiline
                maxLength={500}
              />
              <Button size="sm" disabled={mutations.setMyPin.isPending} onPress={confirmPin}>
                <Check size={14} color={colors.primaryForeground} />
                <Text className="text-xs text-primary-foreground">Confirm Pin</Text>
              </Button>
            </View>
          </Animated.View>
        )}
      </View>
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
        contentContainerClassName="px-4 py-4 gap-4"
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
                      <Button size="sm" variant="outline" onPress={handleUnpin}>
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
          ) : undefined
        }
        className="rounded-lg bg-secondary"
      />
    </Animated.View>
  );
}
