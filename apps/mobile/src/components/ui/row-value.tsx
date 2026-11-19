import { type TextProps } from 'react-native';

import { Text } from '@/components/ui/text';
import { LTR_TEXT_DIRECTION } from '@/lib/rtl-text';
import { cn } from '@/lib/utils';

/** How a clamped line ends: the RN text `ellipsizeMode`. */
export type RowEllipsizeMode = NonNullable<TextProps['ellipsizeMode']>;

/** The semantic ink a value or a status can take. */
export type RowValueTone = 'default' | 'good' | 'warn' | 'danger' | 'muted';

const ROW_VALUE_TONE = {
  default: 'text-foreground',
  good: 'text-good',
  warn: 'text-warn',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
} satisfies Record<RowValueTone, string>;

/** The props of the value text a row paints at its trailing edge. */
export type RowValueSpec = Readonly<{
  text: string;
  tone?: RowValueTone;
  /** `mono` suits a code identifier; `numeric` adds tabular figures for a count. */
  face?: 'mono' | 'text' | 'numeric';
  /**
   * Let the value give up width to the row label (`shrink`, the default) or
   * hold its natural width and let the label truncate (`shrink: false`).
   */
  shrink?: boolean;
  ellipsizeMode?: RowEllipsizeMode;
  /** A selectable value wraps inside the row instead of being clamped. */
  selectable?: boolean;
  /** Pin a value that names a version, a range or a URL to a left-to-right run. */
  direction?: 'ltr';
  accessibilityLabel?: string;
  className?: string;
  /** A state that trails the value on its own ink, e.g. ` · Lapsed`. */
  status?: Readonly<{ label: string; tone: RowValueTone }>;
}>;

/**
 * The value text a row paints at its trailing edge, shared by the row frame and
 * `KvRow`.
 */
export function RowValue({
  text,
  tone = 'default',
  face = 'text',
  shrink = true,
  ellipsizeMode = 'middle',
  selectable = false,
  direction,
  accessibilityLabel,
  className,
  status,
}: RowValueSpec) {
  // Android's `selectable` routes the value through ReactTextView, which drops
  // the `maxLines` clamp on attach; a clamped selectable value then wraps past
  // the row and paints a clipped second line. A selectable value therefore
  // wraps inside the row instead of being clamped.
  const lineLimit = selectable ? undefined : 1;
  return (
    <Text
      variant={face === 'mono' ? 'mono' : 'default'}
      selectable={selectable}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={lineLimit}
      ellipsizeMode={lineLimit === undefined ? undefined : ellipsizeMode}
      style={direction === 'ltr' ? LTR_TEXT_DIRECTION : undefined}
      className={cn(
        'min-w-0 text-right text-[13px]',
        shrink ? 'shrink' : 'shrink-0',
        face === 'numeric' && 'tabular-nums',
        ROW_VALUE_TONE[tone],
        className
      )}
    >
      {text}
      {status === undefined ? null : (
        // The status keeps its own ink inside the value's paragraph, so the
        // name before it keeps the row's ordinary colour and the two cannot
        // split onto separate lines.
        <Text className={cn('text-[13px]', ROW_VALUE_TONE[status.tone])}>{status.label}</Text>
      )}
    </Text>
  );
}
