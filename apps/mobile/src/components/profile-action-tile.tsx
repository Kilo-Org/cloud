import { Pressable } from 'react-native';

import { Text } from '@/components/ui/text';

export function ActionTile({
  icon: Icon,
  label,
  color,
  onPress,
  destructive,
  disabled,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  color: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      className={`w-full flex-row items-center gap-3 rounded-lg bg-secondary px-4 py-4 active:opacity-70 ${disabled ? 'opacity-50' : ''}`}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
    >
      <Icon size={20} color={color} />
      <Text
        className={`min-w-0 flex-1 text-sm ${destructive ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
