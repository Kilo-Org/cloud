import { type ComponentType, type ReactNode } from 'react';
import {
  type AccessibilityRole,
  type AccessibilityState,
  type AccessibilityValue,
  type Insets,
  Pressable,
  View,
  type ViewProps,
} from 'react-native';

import { IconTile } from '@/components/ui/icon-tile';
import { type LucideProps } from '@/components/ui/icons';
import { type RowEllipsizeMode } from '@/components/ui/row-value';
import { renderRowTrailing, type RowTrailingSpec } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';
import { ROW_FRAME_CONTENT_PRESS_CLASS } from '@/lib/a11y/tap-target';
import { NEUTRAL_TINT, type Tint } from '@/lib/agent-color';
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

/**
 * The frame as a column: the row's own line, then a caption line under both
 * columns. The inset and the minimum height stay the frame's, so a row with a
 * caption starts its text at the same x and keeps the same rhythm as its
 * siblings.
 */
const ROW_FRAME_COLUMN_CLASS = 'min-h-[48px] px-4 py-3';

/** The row's own line inside the column frame. */
const ROW_FRAME_LINE_CLASS = 'flex-row items-center justify-between gap-3';

/** The row's leading tile frame, at the 30pt `IconTile` size. */
export const ROW_TILE_CLASS = 'h-[30px] w-[30px] shrink-0 rounded-lg';

const TITLE_CLASS = 'text-sm font-medium';
const SUBTITLE_CLASS = 'mt-0.5 text-xs text-muted-foreground';

/** A subtitle line and the face and truncation it paints in. */
type RowLine = Readonly<{
  text: string;
  /** `mono` for an identifier, a version or a device id beside a sans title. */
  face?: 'default' | 'mono';
  numberOfLines?: number;
  ellipsizeMode?: RowEllipsizeMode;
  className?: string;
}>;

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
  /**
   * A line under the whole row, below both columns — a caption that belongs to
   * the row's value but cannot share its line. It spans the row's width, so a
   * wrapped sentence is never clamped to the value's column. A footer takes the
   * column frame, so it paints under the row's own line on every press path;
   * `stack` is not combined with it, because stacking puts the leading cell
   * above the text column and a footer belongs under both.
   */
  footer?: ReactNode;
  /** The trailing slot: one of the typed marks, or a node a wrapper built. */
  trailing?: RowTrailingSpec;
  /** Makes the frame a pressable row. Omit it and the row is static. */
  onPress?: () => void;
  /**
   * Where the press lives. `row` (the default) makes the whole row the control.
   * `content` presses only the leading cell and the text, so a trailing control
   * (a switch) owns its own touch and its own accessible node. A `content` press
   * is hidden from assistive technology unless `contentAccessibilityLabel`
   * names it, because a preference row's trailing switch already carries the
   * row's name.
   */
  pressTarget?: 'row' | 'content';
  /**
   * The content press's spoken name. Set it when the content opens something of
   * its own (an edit sheet) beside the row's trailing controls, so a screen
   * reader reaches it as a control rather than passing the row by.
   */
  contentAccessibilityLabel?: string;
  contentAccessibilityHint?: string;
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

function renderLine(line: RowLine | undefined, key: string): ReactNode {
  if (line === undefined) {
    return null;
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
  footer,
  trailing,
  onPress,
  pressTarget = 'row',
  contentAccessibilityLabel,
  contentAccessibilityHint,
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

  let bodyText: ReactNode = null;
  if (children !== undefined) {
    bodyText = children;
  } else {
    let titleNode: ReactNode = null;
    if (title !== undefined) {
      const titleText = (
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          className={cn(
            TITLE_CLASS,
            titleBadge !== undefined && 'min-w-0 shrink',
            titleClassName ?? 'text-foreground'
          )}
        >
          {title}
        </Text>
      );
      titleNode =
        titleBadge === undefined ? (
          titleText
        ) : (
          <View className="flex-row items-center gap-2">
            {titleText}
            <View className="shrink-0">{titleBadge}</View>
          </View>
        );
    }
    bodyText = (
      <>
        {titleNode}
        {subtitle === undefined && subtitlePlaceholder !== undefined
          ? subtitlePlaceholder
          : renderLine(subtitle, 'subtitle')}
        {renderLine(secondSubtitle, 'second-subtitle')}
      </>
    );
  }

  const hasText =
    children !== undefined ||
    title !== undefined ||
    subtitle !== undefined ||
    secondSubtitle !== undefined ||
    subtitlePlaceholder !== undefined;

  // The text column owns the free width; a row that carries only a label and a
  // value (a `KvRow`) leaves it out, and `justify-between` holds the value at
  // the trailing edge.
  const textBlock = hasText ? (
    <View className={cn('min-w-0', stack ? 'w-full' : 'flex-1')}>{bodyText}</View>
  ) : null;

  const trailingNode = renderRowTrailing(trailing);
  // A caller that hands a footer gets the column frame: the row's own line
  // first, then that line under both columns at the row's full width.
  const frameClass =
    footer === undefined
      ? cn(stack ? ROW_FRAME_STACK_CLASS : ROW_FRAME_CLASS, className)
      : cn(ROW_FRAME_COLUMN_CLASS, className);

  /**
   * The row's own line, in the order the caller's shape asks for. A footer
   * closes the column below it, so the line keeps the leading cell, the text
   * column and the trailing cell side by side. A stack puts the leading cell and
   * the trailing cell on a line above the text column.
   */
  const renderBody = (): ReactNode => {
    if (footer !== undefined) {
      return (
        <>
          <View className={ROW_FRAME_LINE_CLASS}>
            {leadingNode}
            {textBlock}
            {trailingNode}
          </View>
          {footer}
        </>
      );
    }
    if (stack) {
      return (
        <>
          <View className={cn('w-full', ROW_FRAME_LINE_CLASS)}>
            {leadingNode}
            {trailingNode ? <View className="shrink-0">{trailingNode}</View> : null}
          </View>
          {textBlock}
        </>
      );
    }
    return (
      <>
        {leadingNode}
        {textBlock}
        {trailingNode}
      </>
    );
  };

  if (pressTarget === 'content') {
    // The trailing control owns the row's name when the content is only its
    // label (a preference row). A content press that opens a surface of its own
    // is named instead, so a reader reaches both controls.
    const contentOwnsName = contentAccessibilityLabel !== undefined;
    const contentProps = {
      onPress,
      disabled,
      accessible: contentOwnsName,
      importantForAccessibility: contentOwnsName
        ? ('yes' as const)
        : ('no-hide-descendants' as const),
      accessibilityRole: contentOwnsName ? (accessibilityRole ?? 'button') : undefined,
      accessibilityLabel: contentAccessibilityLabel,
      accessibilityHint: contentAccessibilityHint,
      accessibilityState: contentOwnsName ? { disabled } : undefined,
    };
    const contentPress = (
      <Pressable
        {...contentProps}
        className={cn(
          'min-w-0 flex-1 flex-row items-center gap-3 self-stretch',
          ROW_FRAME_CONTENT_PRESS_CLASS,
          !disabled && 'active:opacity-70'
        )}
      >
        {leadingNode}
        {textBlock}
      </Pressable>
    );
    if (footer === undefined) {
      return (
        <View testID={testID} className={frameClass} onLayout={onLayout}>
          {contentPress}
          {trailingNode}
        </View>
      );
    }
    return (
      <View testID={testID} className={frameClass} onLayout={onLayout}>
        <View className={ROW_FRAME_LINE_CLASS}>
          {contentPress}
          {trailingNode}
        </View>
        {footer}
      </View>
    );
  }

  if (onPress === undefined) {
    return (
      <View testID={testID} className={frameClass} onLayout={onLayout}>
        {renderBody()}
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
      // The caller's states (expanded, busy, selected) belong to the row, so
      // they merge instead of being replaced: a disabled row that is expanded
      // still reports both. The row's own `disabled` wins when it is set.
      accessibilityState={{
        ...accessibilityState,
        disabled: disabled || accessibilityState?.disabled === true,
      }}
      accessibilityValue={accessibilityValue}
      hitSlop={hitSlop}
      onLayout={onLayout}
    >
      {renderBody()}
    </Pressable>
  );
}
