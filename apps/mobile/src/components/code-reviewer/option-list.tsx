import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type OptionListProps<T extends string, TSaveResult> = {
  title: string;
  options: readonly T[];
  selected: T | undefined;
  /** Must resolve/reject once the save actually completes — the screen
   * navigates back only on confirmed success. */
  onSelect: (value: T) => Promise<TSaveResult>;
  /** Optional per-option row label; defaults to the raw option value. */
  labels?: Readonly<Record<T, string>>;
  /** Optional per-option caption below the label. */
  descriptions?: Readonly<Record<T, string>>;
  /** Disables every row, e.g. while the config backing `selected` is still loading. */
  disabled?: boolean;
};

/** Full-screen single-select list. Selecting saves, then pops the screen only once the save confirms. */
export function OptionList<T extends string, TSaveResult>({
  title,
  options,
  selected,
  onSelect,
  labels,
  descriptions,
  disabled,
}: Readonly<OptionListProps<T, TSaveResult>>) {
  const router = useRouter();
  const colors = useThemeColors();
  const [pending, setPending] = useState<T | null>(null);

  const handleSelect = async (option: T) => {
    setPending(option);
    try {
      await onSelect(option);
      router.back();
    } catch {
      // The save hook already surfaces the failure (toast + cache
      // rollback) — just stop showing this row as pending so the user can
      // retry or pick something else.
    } finally {
      setPending(null);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} />
      <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
        <RadioGroup label={title}>
          {options.map(option => (
            <View key={option} className="relative">
              <ChoiceRow
                label={labels?.[option] ?? option}
                description={descriptions?.[option]}
                selected={selected === option}
                disabled={Boolean(disabled) || pending !== null}
                busy={pending === option}
                onPress={() => {
                  void handleSelect(option);
                }}
                className="border-b-[0.5px] border-hair-soft"
              />
              {pending === option && (
                <View className="absolute inset-y-0 right-0 justify-center" pointerEvents="none">
                  <ActivityIndicator size="small" color={colors.mutedForeground} />
                </View>
              )}
            </View>
          ))}
        </RadioGroup>
      </TabScreenScrollView>
    </View>
  );
}
