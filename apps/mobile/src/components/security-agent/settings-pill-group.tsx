import * as Haptics from 'expo-haptics';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * Labeled segmented-pill picker for a fixed set of enum options — shared by
 * the Automation screen's severity/confidence pickers and the Notification
 * screen's severity pickers. Mirrors the inline pill row already used for
 * analysis mode in analysis-settings-screen.tsx, generalized over the
 * option list so it isn't re-implemented per enum.
 */
export function PillGroup<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  options: { value: T; label: string }[];
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}>) {
  return (
    <View className="gap-2">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {label}
      </Text>
      <View className="flex-row gap-2 rounded-full bg-secondary p-1">
        {options.map(option => {
          const active = value === option.value;
          return (
            <Pressable
              key={option.value}
              disabled={disabled}
              className={cn(
                'flex-1 items-center rounded-full py-2 active:opacity-70',
                active && 'bg-foreground'
              )}
              onPress={() => {
                void Haptics.selectionAsync();
                onChange(option.value);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  active ? 'text-background' : 'text-foreground'
                )}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
