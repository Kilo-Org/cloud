import * as Haptics from 'expo-haptics';
import { Pressable, View } from 'react-native';

import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * Enable/disable row shared by the Security Agent Automation, Notification and
 * SLA settings screens and the Code Reviewer overview — title (and an optional
 * subtitle) on the left, a native `Switch` on the right, a selection haptic on
 * toggle.
 *
 * The row itself is the control. Assistive technology and the touch surface
 * both take the whole row: its node carries the switch role, the name and the
 * checked/disabled state, and a tap anywhere on the title or subtitle flips the
 * value. The native `Switch` stays as the visual, but it is inert — it takes no
 * touch (`pointerEvents="none"` on its wrapper) and it leaves the accessibility
 * tree (`accessible={false}`), so a screen reader announces one switch per row
 * instead of a small thumb beside a plain label, and a tap can only reach the
 * row's single toggle path.
 */
export function ToggleRow({
  title,
  accessibilityLabel,
  subtitle,
  value,
  disabled,
  onValueChange,
}: Readonly<{
  title: string;
  /** Names the switch when rows on one screen share a title. Defaults to `title`. */
  accessibilityLabel?: string;
  subtitle?: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (value: boolean) => void;
}>) {
  const toggle = () => {
    void Haptics.selectionAsync();
    onValueChange(!value);
  };

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={toggle}
      className={cn(
        ROW_TARGET_CLASS,
        'flex-row items-center justify-between rounded-lg bg-secondary p-4',
        !disabled && 'active:opacity-70'
      )}
    >
      <View className="flex-1 pr-3">
        <Text className="text-sm font-medium">{title}</Text>
        {subtitle === undefined ? null : (
          <Text variant="muted" className="text-xs">
            {subtitle}
          </Text>
        )}
      </View>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Switch accessible={false} value={value} disabled={disabled} />
      </View>
    </Pressable>
  );
}
