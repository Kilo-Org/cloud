import { Pressable } from 'react-native';

import { IconTile } from '@/components/ui/icon-tile';
import { Text } from '@/components/ui/text';
import { type LucideIcon } from '@/components/ui/icons';
import { type RowHue, rowTint, toneColor } from '@/lib/agent-color';

export function ActionTile({
  icon: Icon,
  label,
  hue,
  onPress,
  destructive,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  /** Curated destination hue; never derived from the label. */
  hue: RowHue;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      className={`w-full flex-row items-center gap-3 rounded-lg bg-secondary px-3 py-3 active:opacity-70 ${disabled ? 'opacity-50' : ''}`}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
    >
      <IconTile icon={Icon} tint={destructive ? toneColor('danger') : rowTint(hue)} />
      <Text
        className={`min-w-0 flex-1 text-sm ${destructive ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
