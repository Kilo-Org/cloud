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
 * The `Switch` is the row's control. It carries the name, the subtitle as its
 * hint and the checked/disabled state, and its tap flips the value. The title
 * and subtitle sit in a `Pressable` that leaves the accessibility tree
 * (`accessible={false}`, `importantForAccessibility="no-hide-descendants"`,
 * `accessibilityElementsHidden`), so a tap anywhere on the text still flips the
 * value while assistive technology meets exactly one switch per row.
 *
 * Android cannot drop a native switch from the tree from the switch's own
 * props, so the half that leaves the tree is the text, not the switch — the
 * shape `PreferenceRow` and the review memory row already use. The switch is a
 * sibling of the text instead of living inside it: a tap reaches one of the two
 * and flips the value once.
 *
 * A disabled row mutes its title and paints the shared switch's muted pair, the
 * same cue `PreferenceRow` and the Notifications category rows use. The subtitle
 * already reads as secondary copy, so dimming it would only cost contrast.
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
  const commit = (next: boolean) => {
    if (disabled) {
      return;
    }
    selectionHaptic();
    onValueChange(next);
  };

  return (
    <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center rounded-lg bg-secondary')}>
      <Pressable
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        disabled={disabled}
        onPress={() => {
          commit(!value);
        }}
        className={cn(
          ROW_TARGET_CLASS,
          'min-w-0 flex-1 justify-center p-4 pe-3',
          !disabled && 'active:opacity-70'
        )}
      >
        <Text className={cn('text-sm font-medium', disabled && 'text-muted-foreground')}>
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text variant="muted" className="text-xs">
            {subtitle}
          </Text>
        )}
      </Pressable>
      <View className="pe-4">
        <Switch
          value={value}
          disabled={disabled}
          accessibilityLabel={accessibilityLabel ?? title}
          accessibilityHint={subtitle}
          accessibilityState={{ checked: value, disabled }}
          onValueChange={commit}
        />
      </View>
    </View>
  );
}
