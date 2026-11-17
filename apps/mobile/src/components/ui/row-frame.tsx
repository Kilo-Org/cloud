import { Fragment, type ComponentType, type ReactNode } from 'react';
import {
  Pressable,
  View,
  type AccessibilityRole,
  type AccessibilityState,
  type AccessibilityValue,
  type Insets,
  type TextProps,
  type ViewProps,
} from 'react-native';

import { IconTile } from '@/components/ui/icon-tile';
import { type LucideProps } from '@/components/ui/icons';
import { RowCheck } from '@/components/ui/row-check';
import { RowChevron } from '@/components/ui/row-chevron';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT, type Tint } from '@/lib/agent-color';
import { ROW_TARGET_CLASS, textActionTargetClass } from '@/lib/a11y/tap-target';
import { LTR_TEXT_DIRECTION } from '@/lib/rtl-text';
import { cn } from '@/lib/utils';

/**
 * The one row geometry: every settings, navigation and value row renders this
 * frame, so a row in one list starts its text at the same x and is the same
 * height as a row in another.
 */
export const ROW_FRAME_CLASS = 'min-h-[48px] flex-row items-center justify-between gap-3 px-4 py-3';

/**
 * The same frame with the leading cell above the text block, for a window too
 * narrow to keep the title on one line beside the tile and its trailing mark.
 */
export const ROW_FRAME_STACK_CLASS = 'min-h-[48px] gap-2 px-4 py-3';

/** The row's leading tile frame, at the 30pt `IconTile` size. */
export const ROW_TILE_CLASS = 'h-[30px] w-[30px] shrink-0 rounded-lg';

const TITLE_CLASS = 'text-sm font-medium';
const SUBTITLE_CLASS = 'mt-0.5 text-xs text-muted-foreground';

/** How a clamped line ends: the RN text `ellipsizeMode`. */
export type RowEllipsizeMode = NonNullable<TextProps['ellipsizeMode']>;

/** The semantic ink a value or a status can take. */
export type RowValueTone = 'default' | 'good' | 'warn' | 'danger' | 'muted';

/** The single source of a value's ink; `KvRow` maps its `valueTone` here. */
export const ROW_VALUE_TONE = {
  default: 'text-foreground',
  good: 'text-good',
  warn: 'text-warn',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
} satisfies Record<RowValueTone, string>;

/** A subtitle line, or a bare string for the ordinary one-line tail-ellipsized case. */
export type RowLine =
  | string
  | Readonly<{
      text: string;
      /** `mono` for an identifier, a version or a device id beside a sans title. */
      face?: 'default' | 'mono';
      numberOfLines?: number;
      ellipsizeMode?: RowEllipsizeMode;
      className?: string;
    }>;

/** The props of the value text a row or a `KvRow` paints at its trailing edge. */
export type RowValueSpec = Readonly<{
  text: string;
  tone?: RowValueTone;
  /** `mono` suits a code identifier; `numeric` adds tabular figures for a count. */
  face?: 'mono' | 'text' | 'numeric';
  /**
   * Let the value give up width to the label (`shrink`, the default) or hold
   * its natural width and let the label truncate (`shrink: false`).
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
 * The trailing cell of a row, as a typed variant or any node. The variants
 * share one geometry and one ink; a wrapper that already builds its own control
 * passes the node itself.
 */
export type RowTrailingSpec =
  | Readonly<{ kind: 'chevron' }>
  | Readonly<{ kind: 'check'; selected: boolean; disabled?: boolean }>
  | Readonly<{
      kind: 'switch';
      value: boolean;
      onValueChange: (next: boolean) => void;
      disabled?: boolean;
      /** Test handle for the switch itself, for native E2E scripts. */
      testID?: string;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      accessibilityState?: AccessibilityState;
      thumbColor?: string;
      trackColor?: Readonly<{ false: string; true: string }>;
    }>
  | Readonly<{ kind: 'value' } & RowValueSpec>
  | Readonly<{ kind: 'badge'; label: string }>
  | Readonly<{
      kind: 'action';
      label: string;
      onPress: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
      testID?: string;
    }>
  | Readonly<{ kind: 'nodes'; nodes: readonly ReactNode[] }>;

export type RowTrailing = ReactNode | RowTrailingSpec;

type RowFrameProps = Readonly<{
  /** Leading slot: any node, already sized to the row. */
  leading?: ReactNode;
  /** Leading `IconTile`'s icon. Any component taking Lucide props works, brand wrappers included. */
  icon?: ComponentType<LucideProps>;
  iconTint?: Tint;
  /** A node inside the leading tile instead of the icon, e.g. a busy spinner. */
  iconContent?: ReactNode;
  title?: string;
  /** A pill or glyph beside the title, e.g. a "this device" mark. */
  titleBadge?: ReactNode;
  /** The title's ink, for a disabled or destructive row. Defaults to the foreground. */
  titleClassName?: string;
  subtitle?: RowLine;
  /** A second line under the title, e.g. a device id under a session name. */
  secondSubtitle?: RowLine;
  /** A node in the subtitle's place while the value that fills it loads. */
  subtitlePlaceholder?: ReactNode;
  /** The text column's content, instead of `title`/`subtitle`. The caller owns its own type and cue. */
  children?: ReactNode;
  /** The trailing slot: one of the typed marks, or any node. */
  trailing?: RowTrailing;
  /** Makes the frame a pressable row. Omit it and the row is static. */
  onPress?: () => void;
  /**
   * Where the press lives. `row` (the default) makes the whole row the control.
   * `content` presses only the leading cell and the text, so a trailing control
   * (a switch) owns its own touch and its own accessible node.
   */
  pressTarget?: 'row' | 'content';
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  /** The action's hint, for the extra context a label cannot carry. */
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  /** The value of a select row, e.g. the currently chosen option. */
  accessibilityValue?: AccessibilityValue;
  disabled?: boolean;
  /** Test handle for the row's control (or, on a static row, its container). */
  testID?: string;
  hitSlop?: Insets;
  onLayout?: ViewProps['onLayout'];
  /** Stacks the leading cell above the text block, for a narrow window or a large font scale. */
  stack?: boolean;
  className?: string;
}>;

/** The value text a row paints at its trailing edge, shared by `KvRow`. */
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

function isTrailingSpec(trailing: RowTrailing): trailing is RowTrailingSpec {
  return typeof trailing === 'object' && trailing !== null && 'kind' in trailing;
}

function renderTrailing(trailing: RowTrailing | undefined): ReactNode {
  if (trailing === undefined || !isTrailingSpec(trailing)) {
    return trailing;
  }
  switch (trailing.kind) {
    case 'chevron':
      return <RowChevron />;
    case 'check':
      return <RowCheck selected={trailing.selected} disabled={trailing.disabled} />;
    case 'switch':
      return (
        <Switch
          value={trailing.value}
          onValueChange={trailing.onValueChange}
          disabled={trailing.disabled}
          testID={trailing.testID}
          accessibilityLabel={trailing.accessibilityLabel}
          accessibilityHint={trailing.accessibilityHint}
          accessibilityState={
            trailing.accessibilityState ?? {
              disabled: Boolean(trailing.disabled),
              checked: trailing.value,
            }
          }
          thumbColor={trailing.thumbColor}
          trackColor={trailing.trackColor}
        />
      );
    case 'value':
      return <RowValue {...trailing} />;
    case 'badge':
      return (
        <View className="shrink-0 rounded-full border border-border bg-hair-soft px-2 py-0.5">
          <Text variant="caption">{trailing.label}</Text>
        </View>
      );
    case 'action':
      return (
        <Pressable
          className={cn('shrink-0 items-center justify-center', textActionTargetClass())}
          onPress={trailing.onPress}
          disabled={trailing.disabled}
          testID={trailing.testID}
          accessibilityRole="button"
          accessibilityLabel={trailing.accessibilityLabel ?? trailing.label}
          accessibilityState={{ disabled: Boolean(trailing.disabled) }}
        >
          <Text
            variant="mono"
            className={cn(trailing.disabled ? 'text-muted-foreground' : 'text-primary')}
          >
            {trailing.label}
          </Text>
        </Pressable>
      );
    case 'nodes':
      return (
        <View className="shrink-0 flex-row items-center gap-2">
          {trailing.nodes.map((node, index) => (
            <Fragment key={index}>{node}</Fragment>
          ))}
        </View>
      );
  }
}

function renderLine(line: RowLine | undefined, key: string): ReactNode {
  if (line === undefined) {
    return null;
  }
  if (typeof line === 'string') {
    return (
      <Text key={key} numberOfLines={1} ellipsizeMode="tail" className={SUBTITLE_CLASS}>
        {line}
      </Text>
    );
  }
  return (
    <Text
      key={key}
      variant={line.face === 'mono' ? 'mono' : undefined}
      numberOfLines={line.numberOfLines}
      ellipsizeMode={line.ellipsizeMode}
      className={cn(SUBTITLE_CLASS, line.className)}
    >
      {line.text}
    </Text>
  );
}

/**
 * The one row anatomy: a leading cell, a title with up to two subtitle lines,
 * and a trailing mark or value, in one geometry.
 *
 * Geometry lives here and nowhere else. `ConfigureRow`, `PreferenceRow`,
 * `KvRow`, `ChoiceRow` and `RowSkeleton` map onto this frame instead of
 * re-spelling it, so a change to the row's height or inset reaches every row in
 * the app at once.
 */
export function RowFrame({
  leading,
  icon,
  iconTint = NEUTRAL_TINT,
  iconContent,
  title,
  titleBadge,
  titleClassName,
  subtitle,
  secondSubtitle,
  subtitlePlaceholder,
  children,
  trailing,
  onPress,
  pressTarget = 'row',
  accessibilityRole,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  accessibilityValue,
  disabled = false,
  testID,
  hitSlop,
  onLayout,
  stack = false,
  className,
}: RowFrameProps) {
  const leadingNode =
    leading ??
    (icon === undefined && iconContent === undefined ? null : (
      <IconTile icon={icon} tint={iconTint} content={iconContent} />
    ));

  const bodyText =
    children !== undefined ? (
      children
    ) : (
      <>
        {title === undefined ? null : titleBadge === undefined ? (
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            className={cn(TITLE_CLASS, titleClassName ?? 'text-foreground')}
          >
            {title}
          </Text>
        ) : (
          <View className="flex-row items-center gap-2">
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              className={cn('min-w-0 shrink', TITLE_CLASS, titleClassName ?? 'text-foreground')}
            >
              {title}
            </Text>
            <View className="shrink-0">{titleBadge}</View>
          </View>
        )}
        {subtitle === undefined && subtitlePlaceholder !== undefined
          ? subtitlePlaceholder
          : renderLine(subtitle, 'subtitle')}
        {renderLine(secondSubtitle, 'second-subtitle')}
      </>
    );

  const hasText =
    children !== undefined ||
    title !== undefined ||
    subtitle !== undefined ||
    secondSubtitle !== undefined ||
    (subtitle === undefined && subtitlePlaceholder !== undefined);

  // The text column owns the free width; a row that carries only a label and a
  // value (a `KvRow`) leaves it out, and `justify-between` holds the value at
  // the trailing edge.
  const textBlock = hasText ? (
    <View className={cn('min-w-0', stack ? 'w-full' : 'flex-1')}>{bodyText}</View>
  ) : null;

  const trailingNode = renderTrailing(trailing);
  const frameClass = cn(stack ? ROW_FRAME_STACK_CLASS : ROW_FRAME_CLASS, className);

  if (pressTarget === 'content') {
    return (
      <View testID={testID} className={frameClass} onLayout={onLayout}>
        <Pressable
          className={cn(
            ROW_TARGET_CLASS,
            'min-w-0 flex-1 flex-row items-center gap-3',
            !disabled && 'active:opacity-70'
          )}
          onPress={onPress}
          disabled={disabled}
          // The trailing control is the row's accessible node; the content
          // beside it is its label, not a second control a reader stops on.
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          {leadingNode}
          {textBlock}
        </Pressable>
        {trailingNode === null || trailingNode === undefined ? null : trailingNode}
      </View>
    );
  }

  if (onPress === undefined) {
    return (
      <View testID={testID} className={frameClass} onLayout={onLayout}>
        {stack ? (
          <>
            <View className="w-full flex-row items-center justify-between gap-3">
              {leadingNode}
              {trailingNode === null || trailingNode === undefined ? null : (
                <View className="shrink-0">{trailingNode}</View>
              )}
            </View>
            {textBlock}
          </>
        ) : (
          <>
            {leadingNode}
            {textBlock}
            {trailingNode}
          </>
        )}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      className={cn(frameClass, !disabled && 'active:opacity-70')}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={accessibilityState ?? { disabled }}
      accessibilityValue={accessibilityValue}
      hitSlop={hitSlop}
      onLayout={onLayout}
    >
      {stack ? (
        <>
          <View className="w-full flex-row items-center justify-between gap-3">
            {leadingNode}
            {trailingNode === null || trailingNode === undefined ? null : (
              <View className="shrink-0">{trailingNode}</View>
            )}
          </View>
          {textBlock}
        </>
      ) : (
        <>
          {leadingNode}
          {textBlock}
          {trailingNode}
        </>
      )}
    </Pressable>
  );
}
