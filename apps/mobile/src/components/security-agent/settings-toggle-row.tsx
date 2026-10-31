import { selectionHaptic } from '@/lib/haptics';
import { Pressable, useColorScheme, View } from 'react-native';

import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
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
  const colors = useThemeColors();
  // The off thumb is the light end of the surface ladder so it reads as a
  // thumb on the mid-neutral off track. The background token is that light end
  // only in the light scheme; on the near-black dark card it is near-black
  // itself, which left the control looking empty, so the dark scheme takes the
  // foreground instead.
  const offThumbColor = useColorScheme() === 'dark' ? colors.foreground : colors.background;
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
        'flex-row items-center justify-between gap-3 rounded-lg bg-secondary p-4',
        !disabled && 'active:opacity-70'
      )}
    >
      <View className="flex-1">
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
        {/* The platform's own off state is a pale grey track with a pale grey
            thumb, which disappeared on the beige and near-black card surfaces
            this row paints on. Both states come from theme tokens instead:
            the off track is the muted foreground, and each thumb is the
            opposite end of the surface ladder, so the control reads as a
            control in either scheme. The thumb keeps the platform's elevation
            shadow, which is what separates it from the track. */}
        <Switch
          accessible={false}
          value={value}
          disabled={disabled}
          ios_backgroundColor={colors.mutedForeground}
          trackColor={{ false: colors.mutedForeground, true: colors.primary }}
          thumbColor={value ? colors.primaryForeground : offThumbColor}
        />
      </View>
    </Pressable>
  );
}
