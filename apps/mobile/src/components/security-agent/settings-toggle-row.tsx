import { selectionHaptic } from '@/lib/haptics';
import { type LucideIcon } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';

import { IconTile } from '@/components/ui/icon-tile';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * Enable/disable row shared by the Security Agent Automation, Notification and
 * SLA settings screens and the Code Reviewer overview — title (and a subtitle)
 * on the left, a native `Switch` on the right, a selection haptic on toggle.
 *
 * The row is the contract's grouped settings row (`apps/mobile/AGENTS.md`,
 * "Row anatomy"): `min-h-[48px] flex-row items-center gap-2 px-4 py-3`, an
 * optional 30pt leading tile, and no card of its own — the section's `RowGroup`
 * draws the surface and the separators between rows.
 *
 * It stays a local row instead of `PreferenceRow` because these screens name a
 * switch that repeats its visible title ("Email owners" in two sections,
 * "Include existing findings" in two sections): the switch carries a composed
 * accessible name, and `PreferenceRow` has no name override. See the gap
 * reported with this migration.
 *
 * The `Switch` is the row's control. It carries the name, the subtitle as its
 * hint and the checked/disabled state, and its tap flips the value. The title
 * and subtitle sit in a `Pressable` that leaves the accessibility tree
 * (`accessible={false}`, `importantForAccessibility="no-hide-descendants"`), so
 * a tap anywhere on the text still flips the value while assistive technology
 * meets exactly one switch per row.
 *
 * Android cannot drop a native switch from the tree from the switch's own
 * props, so the half that leaves the tree is the text, not the switch — the
 * shape `PreferenceRow` and the review memory row already use. The switch is a
 * sibling of the text instead of living inside it: a tap reaches one of the two
 * and flips the value once.
 *
 * A disabled row mutes its title and paints the shared switch's muted pair, the
 * same cue `PreferenceRow` uses. The subtitle already reads as secondary copy,
 * so dimming it would only cost contrast.
 */
export function ToggleRow({
  icon,
  title,
  accessibilityLabel,
  subtitle,
  value,
  disabled,
  onValueChange,
}: Readonly<{
  /** Leading 30pt tile; the shared neutral tint, as every settings row uses. */
  icon?: LucideIcon;
  title: string;
  /** Names the switch when rows on one screen share a title. Defaults to `title`. */
  accessibilityLabel?: string;
  subtitle?: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (value: boolean) => void;
}>) {
  const Icon = icon;
  const commit = (next: boolean) => {
    if (disabled) {
      return;
    }
    selectionHaptic();
    onValueChange(next);
  };

  return (
    <View className="min-h-[48px] flex-row items-center gap-2 px-4 py-3">
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
          'min-w-0 flex-1 flex-row items-center gap-3',
          !disabled && 'active:opacity-70'
        )}
      >
        {Icon === undefined ? null : <IconTile icon={Icon} tint={NEUTRAL_TINT} />}
        <View accessible={false} importantForAccessibility="no" className="min-w-0 flex-1">
          <Text
            accessible={false}
            importantForAccessibility="no"
            className={cn('text-sm font-medium', disabled && 'text-muted-foreground')}
          >
            {title}
          </Text>
          {subtitle === undefined ? null : (
            <Text
              accessible={false}
              importantForAccessibility="no"
              variant="muted"
              className="mt-0.5 text-xs"
            >
              {subtitle}
            </Text>
          )}
        </View>
      </Pressable>
      <Switch
        value={value}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityHint={subtitle}
        accessibilityState={{ checked: value, disabled }}
        onValueChange={commit}
      />
    </View>
  );
}
