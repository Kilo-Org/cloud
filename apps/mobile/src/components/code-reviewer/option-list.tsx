import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ChoiceRow } from '@/components/ui/choice-row';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type OptionListProps<T extends string> = {
  title: string;
  options: readonly T[];
  selected: T | undefined;
  /** Must resolve/reject once the save actually completes — the screen
   * navigates back only on confirmed success. */
  onSelect: (value: T) => Promise<unknown>;
  /** Optional per-option caption below the label. */
  descriptions?: Readonly<Record<T, string>>;
  /** Disables every row, e.g. while the config backing `selected` is still loading. */
  disabled?: boolean;
};

/** Full-screen single-select list. Selecting saves, then pops the screen only once the save confirms. */
export function OptionList<T extends string>({
  title,
  options,
  selected,
  onSelect,
  descriptions,
  disabled,
}: Readonly<OptionListProps<T>>) {
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
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="pt-4">
        {options.map(option => (
          <View key={option} className="relative">
            <ChoiceRow
              label={option}
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
      </TabScreenScrollView>
    </View>
  );
}
