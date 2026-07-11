import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ChoiceRow } from '@/components/ui/choice-row';

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

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} />
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="pt-4">
        {options.map(option => (
          <ChoiceRow
            key={option}
            label={option}
            description={descriptions?.[option]}
            selected={selected === option}
            onPress={() => {
              onSelect(option);
              router.back();
            }}
            className="border-b-[0.5px] border-hair-soft"
          />
        ))}
      </TabScreenScrollView>
    </View>
  );
}
