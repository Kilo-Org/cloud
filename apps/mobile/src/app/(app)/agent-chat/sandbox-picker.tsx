import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { Button } from '@/components/ui/button';
import { Check, Cpu } from '@/components/ui/icons';
import { radioItemA11y } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useSandboxSelection } from '@/lib/hooks/use-sandbox-selection';
import {
  formatSandboxDefaultLabel,
  formatSandboxOptionLabel,
  isSameSandboxAllocation,
  resolveSandboxOptionGroups,
  type SandboxAllocation,
  sandboxAllocationKey,
} from '@/lib/sandbox-allocation-label';
import { sandboxPickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';

const SKELETON_ROW_COUNT = 4;

/**
 * The new-session sandbox picker, presented as the standard formSheet. The
 * backend's options travel on the bridge, and the picker re-queries the same
 * capabilities key so an open sheet is fresh and a failure has a Retry.
 */
export default function SandboxPickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  useRouteRegistry(UNFENCED_ROUTE_KEY);
  // Lazy init reads the slot synchronously on first render — no effect, no
  // "Options expired" flash before a later effect populates state.
  const [bridge] = useState(() => sandboxPickerSlot.get(UNFENCED_ROUTE_KEY));

  const { capabilities, status, isFetching, refetch } = useSandboxSelection(bridge?.organizationId);

  function close() {
    router.back();
  }

  function handleSelect(allocation: SandboxAllocation | undefined) {
    // A selection haptic is a capability both iOS and Android have, so this is
    // one implementation for both: this route owns the pick commit and fires
    // the single `Haptics.selectionAsync()` for it. expo-haptics is the app's
    // own cross-platform haptics library (the iOS haptics engine, the Android
    // vibrator), so no platform branch and no platform-specific module belongs
    // on this path.
    void Haptics.selectionAsync();
    bridge?.onSelect(allocation);
    sandboxPickerSlot.clear(UNFENCED_ROUTE_KEY);
    close();
  }

  if (!bridge) {
    return (
      <PickerSheet
        title={t('agentChat.newSession.sandbox')}
        onDone={close}
        scrollable={false}
        expired
      />
    );
  }

  if (status === 'loading') {
    return (
      <PickerSheet title={t('agentChat.newSession.sandbox')} onDone={close} scrollable={false}>
        <View className="bg-background" style={{ paddingBottom: bottom }}>
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
            <View key={i} className="px-4 py-3">
              <Skeleton className="h-5 w-2/3 rounded-md" />
            </View>
          ))}
        </View>
      </PickerSheet>
    );
  }

  if (status === 'error') {
    return (
      <PickerSheet title={t('agentChat.newSession.sandbox')} onDone={close} scrollable={false}>
        <EmptyState
          icon={Cpu}
          placement="center"
          title={t('agentChat.newSession.sandboxCouldNotLoad')}
          description={t('organization.boundary.loadErrorMessage')}
          action={
            <Button
              variant="outline"
              onPress={() => {
                refetch();
              }}
              loading={isFetching}
              accessibilityLabel={t('common.retry')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          }
        />
      </PickerSheet>
    );
  }

  const fallback = {
    enabled: true,
    defaultDestination: bridge.defaultDestination,
    options: bridge.options,
  };
  const groups = resolveSandboxOptionGroups(capabilities ?? fallback);
  const defaultDestination = capabilities?.defaultDestination ?? bridge.defaultDestination;

  return (
    <PickerSheet title={t('agentChat.newSession.sandbox')} onDone={close} onCancel={close}>
      <View accessibilityRole="radiogroup" accessibilityLabel={t('agentChat.newSession.sandbox')}>
        <Pressable
          className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
          onPress={() => {
            handleSelect(undefined);
          }}
          {...radioItemA11y({
            label: formatSandboxDefaultLabel(defaultDestination),
            checked: bridge.currentValue === undefined,
          })}
        >
          <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
            {formatSandboxDefaultLabel(defaultDestination)}
          </Text>
          {bridge.currentValue === undefined ? <Check size={18} color={colors.primary} /> : null}
        </Pressable>

        {groups.map(group => (
          <View key={group.key}>
            <Text
              accessibilityRole="header"
              className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {group.label}
            </Text>
            {group.options.map(option => {
              const selected = isSameSandboxAllocation(option.allocation, bridge.currentValue);
              const label = formatSandboxOptionLabel(option.allocation);
              return (
                <Pressable
                  key={sandboxAllocationKey(option.allocation)}
                  className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary"
                  onPress={() => {
                    handleSelect(option.allocation);
                  }}
                  {...radioItemA11y({ label, checked: selected })}
                >
                  <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
                    {label}
                  </Text>
                  {selected ? <Check size={18} color={colors.primary} /> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </PickerSheet>
  );
}
