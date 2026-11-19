/* eslint-disable max-lines -- the picker's five presentations (expired, loading, error, zero instances, list) share one sheet chrome and one refetch, and the error and zero-instance actions both carry the shared state-action floor */
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { Cloud, RefreshCw, RotateCcw, Server, Terminal } from '@/components/ui/icons';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { View, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState, StateAction } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { stripInlineCodeMarkers } from '@/i18n/plain-copy';
import { formatList } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { instancePickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';
import { resolveLiveInstance } from '@/lib/resolve-live-instance';
import {
  type InstancePickerListItem,
  instancePickerListItems,
  resolveInstancePickerViewState,
} from '@/lib/instance-picker-rows';
import { useTRPC } from '@/lib/trpc';

const POLL_INTERVAL_MS = 10_000;
const SKELETON_ROW_COUNT = 4;
const INSTANCE_GROUP_LABEL_KEYS = {
  remote: 'agentChat.instancePicker.remotes',
  cli: 'agentChat.instancePicker.terminals',
};

// The picker sheet renders its own scroll container (`scrollable={false}`), so
// the list fills the sheet's body. FlashList takes `style`/`contentContainerStyle`
// (never `className`), and the list carries the sheet background itself because
// no wrapping View may sit between the formSheet header and the list.
const listStyle = { flex: 1 } satisfies ViewStyle;

export default function InstancePickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t, i18n } = useTranslation();
  // The sheet rides the full detent over the gesture-nav bar, so its content
  // clears the bar with the non-tab detail floor, not the raw inset: devices
  // that report a zero bottom inset still keep the bottom action visible and
  // tappable.
  const bottomClearance = useDetailScreenBottomPadding();
  const [bridge, setBridge] = useState(() => instancePickerSlot.get(UNFENCED_ROUTE_KEY));
  const bridgeRef = useRef(bridge);
  useRouteRegistry(UNFENCED_ROUTE_KEY);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  // The instances query lives IN the picker (per the slice spec) so an
  // already-open picker self-populates as CLIs connect/disconnect without
  // needing the parent new-agent screen to keep it warm. The 10s poll
  // (`refetchInterval`) already covers an OS-level foreground return, and
  // returning to the picker route is covered by the `refetchInstances()`
  // call in the `useFocusEffect` below, so this query deliberately omits
  // `refetchOnWindowFocus` — no second fetch is issued at the same moment
  // as a poll tick.
  const trpc = useTRPC();
  const {
    data: instancesData,
    isPending: isLoadingInstances,
    isError: isInstancesError,
    isRefetching,
    refetch: refetchInstances,
  } = useQuery({
    ...trpc.activeSessions.listInstances.queryOptions(undefined, {
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
      const nextBridge = instancePickerSlot.get(UNFENCED_ROUTE_KEY);
      bridgeRef.current = nextBridge;
      setBridge(nextBridge);
      // kilocode_change - `refetchOnWindowFocus` only reacts to OS-level
      // app foreground/background transitions, not Expo Router route
      // focus. Route focus (this screen becoming the active route, i.e.
      // the picker sheet opening) is the case AC1's "refetch on focus"
      // actually describes, so refetch explicitly here too.
      void refetchInstances();

      // The bridge outlives a blur: `useRouteRegistry` clears this route's
      // slots when the route unmounts, so a return to a sheet that is still on
      // screen shows its options again instead of the "options expired" shell.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- refetchInstances is a stable react-query function identity; including it would re-run this effect on every render because react-query does not memoize it across renders.
    }, [])
  );

  const instances: InstancePickerInstance[] = useMemo(
    () => instancesData?.instances ?? [],
    [instancesData]
  );

  const listItems = useMemo(
    () => instancePickerListItems(instances, i18n.language),
    [instances, i18n.language]
  );

  const viewState = resolveInstancePickerViewState({
    isLoading: isLoadingInstances,
    isError: isInstancesError,
    instances,
  });

  const handleSelectCloudAgent = useCallback(() => {
    bridgeRef.current?.onSelect(null);
    instancePickerSlot.clear(UNFENCED_ROUTE_KEY);
    bridgeRef.current = undefined;
    closePicker();
  }, [closePicker]);

  const handleSelectInstance = useCallback(
    (instance: InstancePickerInstance) => {
      bridgeRef.current?.onSelect(instance);
      instancePickerSlot.clear(UNFENCED_ROUTE_KEY);
      bridgeRef.current = undefined;
      closePicker();
    },
    [closePicker]
  );

  // The bridge carries the form's target as it stood when the sheet opened. A
  // host that rebooted reconnects its CLI with the same name and project under
  // a new connectionId, so matching that snapshot by identifier alone marks no
  // row at all while the form still names the target. Resolve it onto the live
  // row first, with the same rule the spawn path uses (`resolveLiveInstance`),
  // so the row the form shows is the row the sheet marks.
  const formTarget = bridge?.currentValue ?? null;
  const liveTarget = formTarget === null ? null : resolveLiveInstance(formTarget, instances);
  const currentConnectionId = liveTarget?.connectionId ?? null;
  // The pending computer target owns the form: neither the Cloud Agent row
  // nor any instance row is the current selection, so no check mark renders.
  const pendingComputer = bridge?.pendingComputer === true && formTarget === null;
  // The form runs on the Cloud Agent only when it holds no instance. A target
  // that no live row represents (the host left the list) is not the Cloud
  // Agent, so it marks no row instead of claiming one.
  const cloudAgentSelected = formTarget === null && !pendingComputer;

  // Hoisted so the list keeps one renderer identity across unrelated screen
  // renders (a poll tick, the bridge refresh); FlashList's memoized cell
  // compares `renderItem` by identity before re-rendering a mounted row.
  const renderItem = useCallback(
    ({ item: row }: { item: InstancePickerListItem | undefined }) => {
      // A stale index past the end of the rows (the model picker's renderItem
      // carries the same guard for the same reason).
      if (!row) {
        return null;
      }
      if (row.type === 'header') {
        return <SectionHeader inset label={t(INSTANCE_GROUP_LABEL_KEYS[row.kind])} />;
      }
      const item = row.instance;
      const selected = !pendingComputer && item.connectionId === currentConnectionId;
      const InstanceIcon = item.kind === 'remote' ? Server : Terminal;
      const identity = item.dedupSuffix
        ? t('agentChat.instancePicker.instanceOnProjectSuffix', {
            name: item.name,
            project: item.projectName,
            suffix: item.dedupSuffix,
          })
        : t('agentChat.instancePicker.instanceOnProject', {
            name: item.name,
            project: item.projectName,
          });
      const label = formatList(
        [t(INSTANCE_GROUP_LABEL_KEYS[item.kind]), identity, item.displayFacts].filter(Boolean),
        i18n.language
      );
      return (
        <ChoiceRow
          testID={item.testID}
          className="border-b-[0.5px] border-hair-soft"
          selected={selected}
          accessibleName={label}
          onPress={() => {
            handleSelectInstance(item);
          }}
        >
          <View className="min-w-0 flex-1 flex-row items-center gap-3">
            <InstanceIcon size={18} color={colors.foreground} />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-medium" numberOfLines={1}>
                {item.name}
              </Text>
              <Text variant="muted" className="mt-0.5 text-xs">
                {item.projectName}
              </Text>
              {item.displayFacts ? (
                <Text variant="muted" className="mt-0.5 text-xs">
                  {item.displayFacts}
                </Text>
              ) : null}
              {item.dedupSuffix ? (
                <Text variant="mono" className="mt-0.5 text-xs text-muted-foreground">
                  #{item.dedupSuffix}
                </Text>
              ) : null}
            </View>
          </View>
        </ChoiceRow>
      );
    },
    [currentConnectionId, pendingComputer, colors, handleSelectInstance, t, i18n.language]
  );

  if (!bridge) {
    return (
      <PickerSheet
        title={t('agentChat.instancePicker.runOn')}
        onDone={closePicker}
        onCancel={closePicker}
        scrollable={false}
        expired
      />
    );
  }

  // Loading: query has never produced data. The empty-snapshot state is
  // "we know the list is empty" — that's success with an empty array, not
  // a loading screen.
  if (viewState.kind === 'loading') {
    return (
      <PickerSheet
        title={t('agentChat.instancePicker.runOn')}
        onDone={closePicker}
        onCancel={closePicker}
        scrollable={false}
      >
        <View className="bg-background" style={{ paddingBottom: bottomClearance }}>
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
            <RowSkeleton key={i} subtitle />
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
        onCancel={closePicker}
        scrollable={false}
      >
        <EmptyState
          icon={Server}
          placement="center"
          title={t('agentChat.instancePicker.couldNotLoad')}
          description={t('organization.boundary.loadErrorMessage')}
          action={
            <StateAction
              label={t('common.retry')}
              icon={RotateCcw}
              onPress={() => {
                void refetchInstances();
              }}
              loading={isRefetching}
            />
          }
        />
      </PickerSheet>
    );
  }

  // Success: even if zero CLI instances are connected, we still render the
  // Cloud Agent default row first (it's always selectable) and append a
  // refreshable "no instances" empty card below. This matches the spec
  // ("Empty: succeeds, zero instances" with a Refresh CTA) without hiding
  // the only target the user can actually pick right now.
  return (
    <PickerSheet
      title={t('agentChat.instancePicker.runOn')}
      onDone={closePicker}
      onCancel={closePicker}
      scrollable={false}
    >
      {/* The list must stay a direct child of the sheet header for native
          formSheet sizing, so the radiogroup role and the visible "Run on"
          group name live on the FlashList container instead of a wrapper. */}
      <FlashList<InstancePickerListItem>
        nestedScrollEnabled
        style={[listStyle, { backgroundColor: colors.background }]}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('agentChat.instancePicker.runOn')}
        data={listItems}
        // FlashList stores its props during render and can index `data` past
        // its end for a render React discarded; the fallbacks are the ones
        // FlashList uses when these callbacks are absent (see the model
        // picker's comment).
        keyExtractor={(item: InstancePickerListItem | undefined, index) =>
          item?.key ?? String(index)
        }
        getItemType={(item: InstancePickerListItem | undefined) => item?.type}
        maintainVisibleContentPosition={{ disabled: true }}
        contentContainerStyle={{ paddingBottom: bottomClearance }}
        ListHeaderComponent={
          <ChoiceRow
            className="border-b-[0.5px] border-hair-soft"
            selected={cloudAgentSelected}
            accessibleName={t('agentChat.instancePicker.runOnCloudAgent')}
            onPress={handleSelectCloudAgent}
          >
            <View className="min-w-0 flex-1 flex-row items-center gap-3">
              <Cloud size={18} color={colors.foreground} />
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-medium" numberOfLines={1}>
                  {t('agentChat.instancePicker.cloudAgent')}
                </Text>
                <Text variant="muted" className="mt-0.5 text-xs">
                  {t('agentChat.instancePicker.cloudAgentDescription')}
                </Text>
              </View>
            </View>
          </ChoiceRow>
        }
        ListEmptyComponent={
          // The half detent sizes this sheet to its title row; the full stack
          // (bubble, copy and action) then ran past the home indicator and left
          // Refresh off screen. The short form keeps the title, the description
          // and the action, and the list's own bottom clearance keeps the
          // action above the bar.
          <EmptyState
            icon={Server}
            placement="top"
            inset="gutter"
            compact
            title={t('agentChat.instancePicker.noCliInstances')}
            description={stripInlineCodeMarkers(
              t('agentChat.instancePicker.noCliInstancesDescription')
            )}
            action={
              <StateAction
                label={t('common.refresh')}
                icon={RefreshCw}
                onPress={() => {
                  void refetchInstances();
                }}
                loading={isRefetching}
              />
            }
          />
        }
        renderItem={renderItem}
      />
    </PickerSheet>
  );
}
