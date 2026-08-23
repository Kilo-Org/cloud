import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Check, Cloud, Server } from '@/components/ui/icons';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { Button } from '@/components/ui/button';
import { radioItemA11y } from '@/components/ui/radio-group';
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
  const { t } = useTranslation();
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
    return (
      <PickerSheet
        title={t('agentChat.instancePicker.runOn')}
        onDone={closePicker}
        scrollable={false}
        expired
      />
    );
  }

  const current = bridge.currentValue;
  const currentConnectionId = current?.connectionId ?? null;

  // Loading: query has never produced data. The empty-snapshot state is
  // "we know the list is empty" — that's success with an empty array, not
  // a loading screen.
  if (viewState.kind === 'loading') {
    return (
      <PickerSheet
        title={t('agentChat.instancePicker.runOn')}
        onDone={closePicker}
        scrollable={false}
      >
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
      <PickerSheet
        title={t('agentChat.instancePicker.runOn')}
        onDone={closePicker}
        scrollable={false}
      >
        <View className="flex-1 items-center justify-center" style={{ paddingBottom: bottom }}>
          <EmptyState
            icon={Server}
            placement="center"
            title={t('agentChat.instancePicker.couldNotLoad')}
            description={t('agentChat.instancePicker.couldNotLoadDescription')}
            action={
              <Button
                variant="outline"
                onPress={() => {
                  void refetchInstances();
                }}
                loading={isRefetching}
                accessibilityLabel={t('common.retry')}
              >
                <Text>{t('common.retry')}</Text>
              </Button>
            }
          />
        </View>
      </PickerSheet>
    );
  }

  const renderItem = ({ item }: { item: LabeledInstance }) => {
    const selected = item.connectionId === currentConnectionId;
    const label = item.dedupSuffix
      ? t('agentChat.instancePicker.instanceOnProjectSuffix', {
          name: item.name,
          project: item.projectName,
          suffix: item.dedupSuffix,
        })
      : t('agentChat.instancePicker.instanceOnProject', {
          name: item.name,
          project: item.projectName,
        });
    return (
      <Pressable
        className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
        onPress={() => {
          handleSelectInstance(item);
        }}
        {...radioItemA11y({ label, checked: selected })}
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
    <PickerSheet
      title={t('agentChat.instancePicker.runOn')}
      onDone={closePicker}
      scrollable={false}
    >
      {/* The list must stay a direct child of the sheet header for native
          formSheet sizing, so the radiogroup role and the visible "Run on"
          group name live on the FlatList container instead of a wrapper. */}
      <FlatList
        className="flex-1 bg-background"
        accessibilityRole="radiogroup"
        accessibilityLabel={t('agentChat.instancePicker.runOn')}
        data={labeled}
        keyExtractor={item => item.connectionId}
        contentContainerStyle={{ paddingBottom: bottom }}
        ListHeaderComponent={
          <Pressable
            className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
            onPress={handleSelectCloudAgent}
            {...radioItemA11y({
              label: t('agentChat.instancePicker.runOnCloudAgent'),
              checked: currentConnectionId === null,
            })}
          >
            <Cloud size={18} color={colors.foreground} />
            <View className="flex-1">
              <Text className="text-base font-medium text-foreground">
                {t('agentChat.instancePicker.cloudAgent')}
              </Text>
              <Text variant="muted" className="text-sm">
                {t('agentChat.instancePicker.cloudAgentDescription')}
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
              title={t('agentChat.instancePicker.noCliInstances')}
              description={t('agentChat.instancePicker.noCliInstancesDescription')}
              action={
                <Button
                  variant="outline"
                  onPress={() => {
                    void refetchInstances();
                  }}
                  loading={isRefetching}
                  accessibilityLabel={t('common.refresh')}
                >
                  <Text>{t('common.refresh')}</Text>
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
