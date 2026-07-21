import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Check, Cloud, Server } from 'lucide-react-native';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  clearInstancePickerBridge,
  getInstancePickerBridge,
  type InstancePickerInstance,
} from '@/lib/picker-bridge';
import {
  dedupeInstanceLabels,
  type LabeledInstance,
  resolveInstancePickerViewState,
} from '@/lib/instance-picker-rows';
import { useTRPC } from '@/lib/trpc';

const POLL_INTERVAL_MS = 10_000;
const SKELETON_ROW_COUNT = 4;

export default function InstancePickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const [bridge, setBridge] = useState(() => getInstancePickerBridge());
  const bridgeRef = useRef(bridge);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  // The instances query lives IN the picker (per the slice spec) so an
  // already-open picker self-populates as CLIs connect/disconnect without
  // needing the parent new-agent screen to keep it warm. `refetchOnWindowFocus`
  // plus the 10s poll covers the AC1 "an already-open picker populates
  // without closing" requirement from both directions (foreground return
  // and steady background ticking).
  const trpc = useTRPC();
  const {
    data: instancesData,
    isPending: isLoadingInstances,
    isError: isInstancesError,
    isRefetching,
    refetch: refetchInstances,
  } = useQuery({
    ...trpc.activeSessions.listInstances.queryOptions(undefined, {
      refetchOnWindowFocus: true,
      refetchInterval: POLL_INTERVAL_MS,
      refetchIntervalInBackground: false,
    }),
    // The listInstances procedure is personal-only; a tRPC throw here would
    // not be expected from a server-side auth decision, but the network
    // path can still fail and we want the retry CTA rather than a stale
    // "successfully empty" snapshot.
    retry: 1,
  });

  useFocusEffect(
    useCallback(() => {
      const nextBridge = getInstancePickerBridge();
      bridgeRef.current = nextBridge;
      setBridge(nextBridge);
      // kilocode_change - `refetchOnWindowFocus` only reacts to OS-level
      // app foreground/background transitions, not Expo Router route
      // focus. Route focus (this screen becoming the active route, i.e.
      // the picker sheet opening) is the case AC1's "refetch on focus"
      // actually describes, so refetch explicitly here too.
      void refetchInstances();

      return () => {
        clearInstancePickerBridge();
        bridgeRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- refetchInstances is a stable react-query function identity; including it would re-run this effect on every render because react-query does not memoize it across renders.
    }, [])
  );

  const instances: InstancePickerInstance[] = useMemo(
    () => instancesData?.instances ?? [],
    [instancesData]
  );

  const labeled = useMemo(() => dedupeInstanceLabels(instances), [instances]);

  const viewState = resolveInstancePickerViewState({
    isLoading: isLoadingInstances,
    isError: isInstancesError,
    instances,
  });

  const handleSelectCloudAgent = useCallback(() => {
    void Haptics.selectionAsync();
    bridgeRef.current?.onSelect(null);
    clearInstancePickerBridge();
    bridgeRef.current = null;
    closePicker();
  }, [closePicker]);

  const handleSelectInstance = useCallback(
    (instance: InstancePickerInstance) => {
      void Haptics.selectionAsync();
      bridgeRef.current?.onSelect(instance);
      clearInstancePickerBridge();
      bridgeRef.current = null;
      closePicker();
    },
    [closePicker]
  );

  if (!bridge) {
    return <PickerSheet title="Run on" onDone={closePicker} scrollable={false} expired />;
  }

  const current = bridge.currentValue;
  const currentConnectionId = current?.connectionId ?? null;

  // Loading: query has never produced data. The empty-snapshot state is
  // "we know the list is empty" — that's success with an empty array, not
  // a loading screen.
  if (viewState.kind === 'loading') {
    return (
      <PickerSheet title="Run on" onDone={closePicker} scrollable={false}>
        <View className="bg-background" style={{ paddingBottom: bottom }}>
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
            <View key={i} className="px-4 py-3">
              <Skeleton className="h-5 w-2/3 rounded-md" />
              <Skeleton className="mt-2 h-4 w-1/3 rounded-md" />
            </View>
          ))}
        </View>
      </PickerSheet>
    );
  }

  // Error: surface a retryable error per the spec. The Empty state below
  // (a successful zero-instance response) and this error are distinct;
  // never collapse them into a single "no instances" surface.
  if (viewState.kind === 'error') {
    return (
      <PickerSheet title="Run on" onDone={closePicker} scrollable={false}>
        <View className="flex-1 items-center justify-center" style={{ paddingBottom: bottom }}>
          <EmptyState
            icon={Server}
            placement="center"
            title="Couldn't load instances"
            description="Check your connection and try again."
            action={
              <Button
                variant="outline"
                onPress={() => {
                  void refetchInstances();
                }}
                loading={isRefetching}
                accessibilityLabel="Retry"
              >
                <Text>Retry</Text>
              </Button>
            }
          />
        </View>
      </PickerSheet>
    );
  }

  const renderItem = ({ item }: { item: LabeledInstance }) => {
    const selected = item.connectionId === currentConnectionId;
    return (
      <Pressable
        className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
        onPress={() => {
          handleSelectInstance(item);
        }}
        accessibilityRole="button"
        accessibilityLabel={
          item.dedupSuffix
            ? `${item.name} on ${item.projectName} (${item.dedupSuffix})`
            : `${item.name} on ${item.projectName}`
        }
      >
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {item.name}
            </Text>
            {item.dedupSuffix ? (
              <Text variant="mono" className="text-xs text-muted-foreground">
                #{item.dedupSuffix}
              </Text>
            ) : null}
          </View>
          <Text variant="muted" className="text-sm" numberOfLines={1}>
            {item.projectName}
          </Text>
        </View>
        {selected ? <Check size={18} color={colors.primary} /> : null}
      </Pressable>
    );
  };

  // Success: even if zero CLI instances are connected, we still render the
  // Cloud Agent default row first (it's always selectable) and append a
  // refreshable "no instances" empty card below. This matches the spec
  // ("Empty: succeeds, zero instances" with a Refresh CTA) without hiding
  // the only target the user can actually pick right now.
  return (
    <PickerSheet title="Run on" onDone={closePicker} scrollable={false}>
      <FlatList
        className="flex-1 bg-background"
        data={labeled}
        keyExtractor={item => item.connectionId}
        contentContainerStyle={{ paddingBottom: bottom }}
        ListHeaderComponent={
          <Pressable
            className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
            onPress={handleSelectCloudAgent}
            accessibilityRole="button"
            accessibilityLabel="Run on Cloud Agent"
          >
            <Cloud size={18} color={colors.foreground} />
            <View className="flex-1">
              <Text className="text-base font-medium text-foreground">Cloud Agent</Text>
              <Text variant="muted" className="text-sm">
                Run on Kilo's cloud sandbox
              </Text>
            </View>
            {currentConnectionId === null ? <Check size={18} color={colors.primary} /> : null}
          </Pressable>
        }
        ListEmptyComponent={
          <View className="items-center justify-center px-6 pt-10">
            <EmptyState
              icon={Server}
              placement="top"
              title="No CLI instances connected"
              description="Run `kilo remote` in a project on your computer to connect one."
              action={
                <Button
                  variant="outline"
                  onPress={() => {
                    void refetchInstances();
                  }}
                  loading={isRefetching}
                  accessibilityLabel="Refresh"
                >
                  <Text>Refresh</Text>
                </Button>
              }
            />
          </View>
        }
        renderItem={renderItem}
      />
    </PickerSheet>
  );
}
