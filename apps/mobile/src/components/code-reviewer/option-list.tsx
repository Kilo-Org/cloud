import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type OptionListProps<T extends string> = {
  title: string;
  options: readonly T[];
  selected: T | undefined;
  onSelect: (value: T) => void;
  /** Optional per-option caption below the label. */
  descriptions?: Readonly<Record<T, string>>;
};

/** Full-screen single-select list. Selecting saves and pops the screen. */
export function OptionList<T extends string>({
  title,
  options,
  selected,
  onSelect,
  descriptions,
}: Readonly<OptionListProps<T>>) {
  const router = useRouter();
  const colors = useThemeColors();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} />
      <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
        {options.map(option => (
          <Pressable
            key={option}
            className="flex-row items-center justify-between border-b-[0.5px] border-hair-soft py-3 active:opacity-70"
            onPress={() => {
              void Haptics.selectionAsync();
              onSelect(option);
              router.back();
            }}
          >
            <View className="flex-1 pr-3">
              <Text className="text-sm font-medium capitalize">{option}</Text>
              {descriptions?.[option] ? (
                <Text variant="muted" className="mt-0.5 text-xs">
                  {descriptions[option]}
                </Text>
              ) : null}
            </View>
            <Check size={18} color={selected === option ? colors.foreground : 'transparent'} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
