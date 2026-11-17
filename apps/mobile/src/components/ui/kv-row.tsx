import { type ComponentType, type ReactNode } from 'react';
import { View, type EllipsizeMode, type Insets } from 'react-native';

import { type LucideProps } from '@/components/ui/icons';
import { RowFrame, RowValue, type RowValueTone } from '@/components/ui/row-frame';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type KvTone = RowValueTone;

type KvRowProps = {
  icon?: ComponentType<LucideProps>;
  label: string;
  value: string;
  valueTone?: RowValueTone;
  /**
   * A state that trails the value on its own ink — the status of the thing the
   * value names. The value keeps the row's ordinary ink, so the state carries
   * the emphasis instead of colouring the name it belongs to.
   */
  valueStatus?: KvStatus;
  /**
   * Renders a small colored status dot before the label to categorize the row,
   * leaving the value uncolored (mirrors the web dashboard's summary rows). Use
   * this instead of `valueTone` when the count itself shouldn't be tinted — a
   * red "0" or green "0" reads as alarming/false-positive.
   */
  dotTone?: KvTone;
  /**
   * The face the value paints in. The default `mono` suits a code identifier —
   * a package name, a version range, an advisory id, a path, a branch. A
   * plain-language value or a timestamp is `text`, because the code face reads
   * as code beside the sans label. `numeric` is `text` with tabular figures,
   * for a column of counts: a count column compares left to right.
   */
  valueFace?: 'mono' | 'text' | 'numeric';
  className?: string;
  /** Test handle for the row's own container, for native E2E scripts. */
  testID?: string;
  /** Allow the value text to be selected/copied (e.g. identifiers, versions, paths). */
  selectable?: boolean;
  /** Extra classes for the value text only (e.g. `uppercase` for a status readout). */
  valueClassName?: string;
  /**
   * Replaces the spoken label of the value node (e.g. a masked amount speaks
   * "Balance hidden" instead of the hidden characters).
   */
  valueAccessibilityLabel?: string;
  /**
   * Render the value as a left-to-right run whatever the interface direction is.
   * A version, a version range and a CVE or GHSA id are written left to right,
   * so the bidi algorithm otherwise reverses a range in a right-to-left locale:
   * `< 6.13.0` paints as `6.13.0 >`, which inverts its meaning.
   */
  valueDirection?: 'ltr';
  /**
   * Where the value truncates. An identifier truncates in the middle so both
   * ends stay legible; a status that ends with its state truncates at the tail.
   */
  valueEllipsizeMode?: EllipsizeMode;
  /**
   * A node in the value's place, for a value that is not one run of text — a
   * badge, a glyph, a value with its own controls. The row keeps its height.
   */
  valueContent?: ReactNode;
  /**
   * A control that belongs to this row, painted after the value at the row's
   * trailing edge — an action for the amount beside it. The row keeps its own
   * height, so the control shares the line instead of opening a block below.
   */
  trailing?: ReactNode;
  /**
   * The label gives up width to the value instead of holding its natural one,
   * so a long label truncates rather than pushing the value out of the row.
   */
  labelShrink?: boolean;
  /**
   * Makes the row pressable — a value that opens what it names. Omit it and the
   * row is a static label/value pair.
   */
  onPress?: () => void;
  /** A row that names a control outside the app, e.g. an advisory page. */
  accessibilityRole?: 'button' | 'link';
  /** Full spoken name when the label and value do not say what the press does. */
  accessibilityLabel?: string;
  disabled?: boolean;
  /** Lets a compact trailing control reach its own touch target inside the row. */
  hitSlop?: Insets;
};

const DOT_TONE = {
  good: 'bg-good',
  warn: 'bg-warn',
  danger: 'bg-destructive',
  muted: 'bg-muted-foreground',
} satisfies Record<KvTone, string>;

/**
 * Value props for a status that trails a value on its own ink — the state of
 * the thing the value names. The label carries its own leading separator in the
 * catalog, so each language keeps its own spacing and the value keeps the row's
 * ordinary colour.
 */
type KvStatus = Readonly<{ label: string; tone: KvTone }>;

/** Label-left / value-right row. */
export function KvRow({
  icon: Icon,
  label,
  value,
  valueTone = 'default',
  valueStatus,
  dotTone,
  valueFace = 'mono',
  className,
  testID,
  selectable,
  valueClassName,
  valueAccessibilityLabel,
  valueDirection,
  valueEllipsizeMode,
  valueContent,
  trailing,
  labelShrink = false,
  onPress,
  accessibilityRole,
  accessibilityLabel,
  disabled,
  hitSlop,
}: Readonly<KvRowProps>) {
  const colors = useThemeColors();
  const labelNode = (
    <View
      className={cn(
        'flex-row items-center gap-2',
        labelShrink ? 'min-w-0 shrink' : 'shrink-0'
      )}
    >
      {dotTone ? <View className={cn('size-2 rounded-full', DOT_TONE[dotTone])} /> : null}
      {Icon ? <Icon size={14} color={colors.mutedForeground} /> : null}
      <Text
        className={cn('text-sm text-muted-foreground', labelShrink && 'min-w-0 shrink')}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );

  const valueNode =
    valueContent ??
    // Android's `selectable` routes the value through ReactTextView, which
    // re-applies selection when the view attaches and drops the `maxLines`
    // clamp. A selectable value then wraps past the row's one-line height and
    // paints a clipped second line (SPOT-DEFECT: the finding-details Manifest
    // row). The value primitive clamps the values that can hold it.
    (
      <RowValue
        text={value}
        tone={valueTone}
        face={valueFace}
        selectable={selectable}
        direction={valueDirection}
        ellipsizeMode={valueEllipsizeMode ?? 'middle'}
        accessibilityLabel={valueAccessibilityLabel}
        className={valueClassName}
        status={valueStatus}
      />
    );

  return (
    <RowFrame
      leading={labelNode}
      trailing={
        trailing === undefined ? (
          valueNode
        ) : (
          // The value keeps its right edge beside the control, so the pair reads
          // as one trailing group on the row the control belongs to.
          <View className="min-w-0 shrink flex-row items-center justify-end gap-3">
            {valueNode}
            {trailing}
          </View>
        )
      }
      testID={testID}
      className={className}
      onPress={onPress}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={hitSlop}
    />
  );
}
