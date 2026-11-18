import { type ComponentType, type ReactNode } from 'react';
import { useColorScheme, View } from 'react-native';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { type LucideProps } from '@/components/ui/icons';
import { RowFrame } from '@/components/ui/row-frame';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { selectionHaptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

type PreferenceRowProps = Readonly<{
  /** Omit it for a switch row that leads with its title, with no tile of its own. */
  icon?: ComponentType<LucideProps>;
  title: string;
  /** The line under the title. Omit it for a one-line switch row. */
  subtitle?: string;
  value: boolean;
  disabled: boolean;
  busy?: boolean;
  onValueChange: (next: boolean) => void;
  /**
   * The subtitle this row shows when its own state stops the preference from
   * applying. The other copy stays in the tree at zero opacity so the row keeps
   * the height of the taller line and never moves when the state changes.
   */
  inactiveSubtitle?: string;
  /**
   * The value a press should flip. Defaults to the rendered `value`, which is
   * the last render, so two presses inside one frame both flip the same state
   * and the second one repeats the first. A store that lags its own writes
   * passes its newest requested value here, and every press then flips the
   * state the person last asked for.
   */
  resolveValue?: () => boolean;
  /**
   * Full spoken name of the switch. Set it when the title alone does not say
   * what the switch controls, e.g. a composed "spend alerts for Acme" name.
   */
  accessibilityLabel?: string;
  /** Test handle for the row's own container, for native E2E scripts. */
  testID?: string;
}>;

/** Switch row shaped like the Notifications category row. */
export function PreferenceRow({
  icon,
  title,
  subtitle,
  value,
  disabled,
  busy = false,
  onValueChange,
  inactiveSubtitle,
  resolveValue,
  accessibilityLabel,
  testID,
}: PreferenceRowProps) {
  const colors = useThemeColors();
  const isDark = useColorScheme() === 'dark';
  // The shared `Switch` already paints the dark scheme: a light grip on the
  // muted ink, which reads as a knob in a dark row. What it cannot know is this
  // row's light surface: its off track is `mutedSoft`, 2.1:1 over the row's
  // `#F0EEE6` card, and Android's own default before it was 1.02:1, so the off
  // control read as two barely-visible grey marks. The light scheme therefore
  // overrides both halves with the muted ink `#6F6A61` (4.6:1 on the row) under
  // the white grip (5.2:1 over that track). The dark scheme passes nothing and
  // takes the shared pair.
  // An unavailable row must not read as both dimmed and on: a full-strength
  // accent track beside the muted title says the control is live. While the row
  // is disabled the light override yields, so the shared `Switch` paints its
  // own muted pair there (`mutedSoft` track, `primaryDisabled` fill); iOS fades
  // the control itself.
  const switchColors =
    isDark || disabled === true
      ? undefined
      : {
          thumbColor: colors.primaryForeground,
          trackColor: { false: colors.mutedForeground, true: colors.primary },
        };
  // Both ways of moving the switch flip the same value: a tap on the row and a
  // tap on the thumb can arrive in either order, and a burst must not build one
  // flip from the rendered value and the next from the native thumb state.
  const flip = () => {
    onValueChange(!(resolveValue?.() ?? value));
  };
  // A tap on the title flips the same value the switch does, so it answers with
  // the same selection tick; the switch's own flip ticks inside `RowFrame`.
  const pressRow = () => {
    selectionHaptic();
    flip();
  };
  // The label column keeps 7 dp from the switch, not 10.5. The longest row
  // title ("Keep screen on while on session page") lands within a few pixels
  // of the column width at 360 dp: Android then measures the title against
  // that boundary, reports a two-line frame while it paints one line, and the
  // description drops a whole line below the title. The extra 3.5 dp keeps the
  // title clear of the boundary, so the frame is the line the row paints.
  // Only the visible subtitle is painted and announced. When the caller passes
  // both, full-width overlapping copies reserve the taller one in native
  // layout — the idiom in form-field's reserved error area — so swapping them
  // cannot change the row's height in any language, font scale or width,
  // without measuring.
  let subtitleNode: ReactNode = null;
  if (subtitle !== undefined) {
    subtitleNode =
      inactiveSubtitle === undefined ? (
        <Text variant="muted" className="mt-0.5 text-xs">
          {subtitle}
        </Text>
      ) : (
        <View className="mt-0.5">
          <View
            className="flex-row opacity-0"
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text variant="muted" className="w-full shrink-0 text-xs">
              {subtitle}
            </Text>
            <Text variant="muted" className="-ms-[100%] w-full shrink-0 text-xs">
              {inactiveSubtitle}
            </Text>
          </View>
          <View className="absolute inset-x-0 top-0">
            <Text variant="muted" className="text-xs">
              {subtitle}
            </Text>
          </View>
        </View>
      );
  }

  return (
    <RowFrame
      testID={testID}
      className="gap-2"
      pressTarget="content"
      icon={icon}
      iconContent={
        busy ? (
          // The busy spinner takes the icon's place inside the tile, never the
          // tile's place: a row that loses its 30 dp column while it saves
          // moves its own title sideways.
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        ) : undefined
      }
      trailing={{
        kind: 'switch',
        value,
        onValueChange: flip,
        disabled,
        thumbColor: switchColors?.thumbColor,
        trackColor: switchColors?.trackColor,
        accessibilityLabel: accessibilityLabel ?? title,
        accessibilityHint: subtitle,
        accessibilityState: { disabled, busy, checked: value },
      }}
      onPress={pressRow}
      disabled={disabled}
    >
      {/* Disabled cue is the muted title, not row opacity — see the same
          pattern in notifications-screen's CategoryRow. */}
      <Text className={cn('text-sm font-medium', disabled && 'text-muted-foreground')}>
        {title}
      </Text>
      {subtitleNode}
    </RowFrame>
  );
}
