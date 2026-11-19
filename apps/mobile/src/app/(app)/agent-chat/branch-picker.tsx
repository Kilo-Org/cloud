import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { PickerSheet } from '@/components/picker-sheet';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Text } from '@/components/ui/text';
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
        onCancel={close}
        scrollable={false}
        expired
      />
    );
  }

  return (
    <PickerSheet
      title={t('agentChat.newSession.branchPickerTitle')}
      onDone={close}
      onCancel={close}
    >
      {/* The provider holds branches this list cannot include. The rows below
          are real but not the whole repository, so the sheet says so before the
          list starts rather than after a thousand rows. */}
      {bridge.truncated ? (
        <View className="border-b-[0.5px] border-hair-soft px-4 py-3">
          <Text variant="muted">{t('agentChat.newSession.branchListIncomplete')}</Text>
        </View>
      ) : null}
      <View>
        {bridge.branches.map(branch => {
          const isSelected = branch === bridge.selectedBranch;
          const isDefault = branch === bridge.defaultBranch;
          return (
            <ChoiceRow
              key={branch}
              className="border-b-[0.5px] border-hair-soft"
              selected={isSelected}
              accessibleName={t('agentChat.newSession.branchAccessibility', { label: branch })}
              onPress={() => {
                handleSelect(bridge, branch);
              }}
            >
              <View className="min-w-0 flex-1 flex-row items-center gap-2">
                <Text
                  className="min-w-0 flex-1 text-sm font-medium"
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {branch}
                </Text>
                {isDefault ? (
                  <Text variant="muted" className="text-xs">
                    {t('agentChat.newSession.branchDefault')}
                  </Text>
                ) : null}
              </View>
            </ChoiceRow>
          );
        })}
      </View>
    </PickerSheet>
  );
}
