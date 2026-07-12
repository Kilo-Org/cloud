import * as Haptics from 'expo-haptics';
import { Check } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/**
 * Labeled single-select picker for a fixed set of enum options — shared by
 * the Automation screen's severity/confidence pickers and the Notification
 * screen's severity pickers. Renders a vertical row list (like the dismiss
 * reason and finding-filter pickers) so long labels stay fully readable
 * instead of being squeezed into a horizontal pill row.
 */
export function PillGroup<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  options: readonly { value: T; label: string }[];
  /** `null` when nothing is selected yet, e.g. an unset dismissal reason. */
  value: T | null;
  disabled: boolean;
  onChange: (value: T) => void;
}>) {
  const colors = useThemeColors();
  return (
    <View className="gap-2">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {label}
      </Text>
      <View className="overflow-hidden rounded-lg bg-secondary">
        {options.map((option, index) => {
          const active = value === option.value;
          return (
            <Pressable
              key={option.value}
              disabled={disabled}
              className={cn(
                'min-h-11 flex-row items-center justify-between px-4 py-3 active:opacity-70',
                index < options.length - 1 && 'border-b-[0.5px] border-hair-soft',
                disabled && 'opacity-50'
              )}
              onPress={() => {
                void Haptics.selectionAsync();
                onChange(option.value);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: active, disabled }}
            >
              <Text
                className={cn(
                  'flex-1 text-sm',
                  active ? 'font-medium text-foreground' : 'text-muted-foreground'
                )}
              >
                {option.label}
              </Text>
              {active && <Check size={16} color={colors.primary} />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
