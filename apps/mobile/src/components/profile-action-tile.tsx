import { Pressable } from 'react-native';

import { IconTile } from '@/components/ui/icon-tile';
import { Text } from '@/components/ui/text';
import { type LucideIcon } from '@/components/ui/icons';
import { agentColor, toneColor } from '@/lib/agent-color';

export function ActionTile({
  icon: Icon,
  label,
  onPress,
  destructive,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
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
      <IconTile icon={Icon} tint={destructive ? toneColor('danger') : agentColor(label)} />
      <Text
        className={`min-w-0 flex-1 text-sm ${destructive ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
