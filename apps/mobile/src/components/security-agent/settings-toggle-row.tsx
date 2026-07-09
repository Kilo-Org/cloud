import * as Haptics from 'expo-haptics';
import { Switch, View } from 'react-native';

import { Text } from '@/components/ui/text';

/**
 * Enable/disable row shared by the Automation, Notification, and SLA
 * settings screens — title + subtitle on the left, a native `Switch` on
 * the right with a selection haptic on toggle.
 */
export function ToggleRow({
  title,
  subtitle,
  value,
  disabled,
  onValueChange,
}: Readonly<{
  title: string;
  subtitle: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (value: boolean) => void;
}>) {
  return (
    <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
      <View className="flex-1 pr-3">
        <Text className="text-sm font-medium">{title}</Text>
        <Text variant="muted" className="text-xs">
          {subtitle}
        </Text>
      </View>
      <Switch
        accessibilityLabel={title}
        value={value}
        disabled={disabled}
        onValueChange={next => {
          void Haptics.selectionAsync();
          onValueChange(next);
        }}
      />
    </View>
  );
}
