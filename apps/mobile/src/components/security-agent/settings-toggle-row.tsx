import { selectionHaptic } from '@/lib/haptics';
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
 * value. The native `Switch` stays as the visual, but it is inert — its wrapper
 * takes no touch (`pointerEvents="none"`) and hides its whole subtree from
 * assistive technology (`accessibilityElementsHidden` on iOS,
 * `importantForAccessibility="no-hide-descendants"` on Android), so a screen
 * reader announces one switch per row instead of a small thumb beside a plain
 * label, and a tap can only reach the row's single toggle path.
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
    if (disabled) {
      return;
    }
    selectionHaptic();
    onValueChange(!value);
  };

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel ?? title}
      // The name above is the title alone, so the subtitle rides along as the
      // hint: the row is one accessibility node now, and its text children are
      // no longer read on their own.
      accessibilityHint={subtitle}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={toggle}
      className={cn(
        ROW_TARGET_CLASS,
        'flex-row items-center justify-between rounded-lg bg-secondary p-4',
        !disabled && 'active:opacity-70'
      )}
    >
      {/* `pe-3` keeps the gap between the text and the switch on the switch's
          side in both directions. A physical `pr-3` mirrored the padding into
          the text's box under RTL: the title kept its reduced width but started
          at the padded edge, so it ran past the row's content box. */}
      <View className="flex-1 pe-3">
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
