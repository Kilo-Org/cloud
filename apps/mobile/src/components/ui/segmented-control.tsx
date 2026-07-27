import * as Haptics from 'expo-haptics';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type SegmentedControlOption<T extends string> = { value: T; label: string };

type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel?: string;
};

/**
 * Horizontal segmented pill. Owns the selection haptic — callers must NOT
 * fire their own `Haptics.selectionAsync()` on press. The haptic only fires
 * on an actual change of selection, not when the current value is re-tapped.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: Readonly<SegmentedControlProps<T>>) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      className="flex-row rounded-lg bg-secondary p-1"
    >
      {options.map(option => {
        const selected = value === option.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => {
              if (selected) {
                return;
              }
              void Haptics.selectionAsync();
              onChange(option.value);
            }}
            className={cn(
              'min-h-11 flex-1 items-center justify-center rounded-md px-3 active:opacity-70',
              selected && 'bg-background'
            )}
          >
            <Text
              className={cn(
                'text-sm',
                selected ? 'font-medium text-foreground' : 'text-muted-foreground'
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
