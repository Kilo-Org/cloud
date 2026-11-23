import { type ComponentType, type ReactNode } from 'react';
import { View } from 'react-native';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { type LucideProps } from '@/components/ui/icons';
import { RowFrame } from '@/components/ui/row-frame';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatList } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { selectionHaptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

type PreferenceRowProps = Readonly<{
  /** Omit it for a switch row that leads with its title, with no tile of its own. */
  icon?: ComponentType<LucideProps>;
  title: string;
  /** The line under the title. Omit it for a one-line switch row. */
  subtitle?: string;
  /**
   * The line cap for the subtitle, and the one place this row departs from
   * `ConfigureRow`. That row's subtitle is often a value, an identifier or a
   * hint that reads best on one line, so it caps the line by default. This
   * row's subtitle explains the switch beside it, and the reader has to be able
   * to finish it, so an omitted cap paints every line. A caller that pairs this
   * copy with a capped sibling passes that sibling's cap so both reserve the
   * same height, and `'all'` states the same uncapped intent when only the
   * sibling has a default.
   */
  subtitleNumberOfLines?: number | 'all';
  /**
   * A second muted line under the subtitle (a model's retirement date, say).
   * It renders only when a caller passes it and joins the switch's spoken
   * name through the shared list formatter, so the row keeps one name.
   */
  note?: string;
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
  subtitleNumberOfLines,
  note,
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
  // The row takes the shared switch pair, which clears the 3:1 non-text floor
  // on every surface this row paints.
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
  // The note is a second muted line, never the title, but the switch keeps one
  // spoken name: the note joins the title through the shared list formatter
  // ("openrouter and Retires Nov 22"), alongside the caller's own override.
  const spokenName = accessibilityLabel ?? title;
  const spokenLabel =
    note === undefined ? spokenName : formatList([spokenName, note], i18n.language);
  const noteNode =
    note === undefined ? null : (
      <Text variant="muted" className="mt-0.5 text-xs">
        {note}
      </Text>
    );
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
  // `'all'` names the same uncapped intent the omitted prop has, so a caller
  // that shares copy with a capped sibling states it without a number.
  const subtitleLines = subtitleNumberOfLines === 'all' ? undefined : subtitleNumberOfLines;
  let subtitleNode: ReactNode = null;
  if (subtitle !== undefined) {
    subtitleNode =
      inactiveSubtitle === undefined ? (
        <Text variant="muted" className="mt-0.5 text-xs" numberOfLines={subtitleLines}>
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
            <Text variant="muted" className="w-full shrink-0 text-xs" numberOfLines={subtitleLines}>
              {subtitle}
            </Text>
            <Text
              variant="muted"
              className="-ms-[100%] w-full shrink-0 text-xs"
              numberOfLines={subtitleLines}
            >
              {inactiveSubtitle}
            </Text>
          </View>
          <View className="absolute inset-x-0 top-0">
            <Text variant="muted" className="text-xs" numberOfLines={subtitleLines}>
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
        accessibilityLabel: spokenLabel,
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
      {noteNode}
    </RowFrame>
  );
}
