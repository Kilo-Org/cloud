import { useRouter } from 'expo-router';
import { Check } from '@/components/ui/icons';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { PickerSheet } from '@/components/picker-sheet';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type BranchPickerBridge } from '@/lib/picker-bridge';
import { branchPickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';

/**
 * The new-session branch picker, presented as the standard formSheet (same
 * shell as the repo/mode/model pickers). The shell's header carries the
 * dismiss controls and the rows render below it, so a Cancel control can
 * never float over — or drift away from — the branch rows.
 */
export default function BranchPickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  useRouteRegistry(UNFENCED_ROUTE_KEY);
  // Lazy init reads the slot synchronously on first render — no effect, no
  // "Options expired" flash before a later effect populates state.
  const [bridge] = useState(() => branchPickerSlot.get(UNFENCED_ROUTE_KEY));

  function close() {
    router.back();
  }

  function handleSelect(picker: BranchPickerBridge, branch: string) {
    picker.onSelect(branch);
    branchPickerSlot.clear(UNFENCED_ROUTE_KEY);
    router.back();
  }

  if (!bridge) {
    return (
      <PickerSheet
        title={t('agentChat.newSession.branchPickerTitle')}
        onDone={close}
        scrollable={false}
        expired
      />
    );
  }

  return (
    <PickerSheet title={t('agentChat.newSession.branchPickerTitle')} onDone={close} onCancel={close}>
      <View>
        {bridge.branches.map(branch => {
          const isSelected = branch === bridge.selectedBranch;
          const isDefault = branch === bridge.defaultBranch;
          return (
            <Pressable
              key={branch}
              className="flex-row items-center gap-3 border-b border-hair-soft px-4 py-3 active:bg-secondary"
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={t('agentChat.newSession.branchAccessibility', { label: branch })}
              onPress={() => {
                handleSelect(bridge, branch);
              }}
            >
              <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
                {branch}
              </Text>
              {isDefault ? (
                <Text className="text-xs text-muted-foreground">
                  {t('agentChat.newSession.branchDefault')}
                </Text>
              ) : null}
              {isSelected ? <Check size={18} color={colors.primary} /> : null}
            </Pressable>
          );
        })}
      </View>
    </PickerSheet>
  );
}
