/**
 * The two row shapes the trigger form is built from beside its text fields: a
 * row that opens a picker with the value it currently holds, and a row that
 * carries a switch.
 *
 * Both keep one line of title and reach the 44pt target with the shared row box
 * rather than by growing the row, as `apps/mobile/AGENTS.md` asks.
 */

import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { ChevronDown } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type TriggerSelectRowProps = Readonly<{
  label: string;
  value: string;
  onPress: () => void;
  disabled?: boolean;
  /** Overrides the composed accessible name when the value alone is not the whole story. */
  accessibilityLabel?: string;
  /** A message the row could not apply the choice, shown under it. */
  error?: string;
}>;

export function TriggerSelectRow({
  label,
  value,
  onPress,
  disabled = false,
  accessibilityLabel,
  error,
}: TriggerSelectRowProps) {
  const colors = useThemeColors();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityValue={{ text: value }}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 active:opacity-70')}
      >
        <Text variant="muted" className="shrink-0">
          {label}
        </Text>
        <Text
          numberOfLines={1}
          className={cn(
            'min-w-0 flex-1 text-right text-sm font-medium',
            disabled ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {value}
        </Text>
        <ChevronDown size={16} color={colors.mutedForeground} />
      </Pressable>
      {error === undefined ? null : <Text className="pb-1 text-xs text-destructive">{error}</Text>}
    </View>
  );
}

type TriggerSwitchRowProps = Readonly<{
  title: string;
  description?: ReactNode;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}>;

export function TriggerSwitchRow({
  title,
  description,
  value,
  onValueChange,
  disabled = false,
}: TriggerSwitchRowProps) {
  return (
    <View className="flex-row items-start gap-3 py-2">
      <View className="min-w-0 flex-1 gap-1">
        <Text
          className={cn(
            'text-sm font-medium',
            disabled ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {title}
        </Text>
        {description === undefined ? null : <Text variant="caption">{description}</Text>}
      </View>
      <Switch
        accessibilityLabel={title}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
      />
    </View>
  );
}
