import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { type LucideIcon } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { IconTile } from '@/components/ui/icon-tile';
import { type ReactNode } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';

import { Text } from '@/components/ui/text';
import {
  NEUTRAL_TINT,
  type RowHue,
  rowTint,
  type Tint,
  toneColor,
  type ToneKey,
} from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { cn } from '@/lib/utils';

/**
 * At/above this Dynamic Type scale, ConfigureRow stacks the icon above the
 * title block so long labels never clip against the chevron in a side row.
 * Matches the tab-label wrap threshold used elsewhere in the shell. A window
 * narrower than `NARROW_LAYOUT_WIDTH` squeezes the same text block and takes
 * the same presentation.
 */
const CONFIGURE_ROW_STACK_FONT_SCALE = 1.8;

type ConfigureRowProps = {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /**
   * Line cap for the subtitle. A subtitle that is one unbreakable token (an
   * email address, a host name) cannot wrap on Android and is hard-clipped at
   * the row edge with no ellipsis; `1` makes it ellipsize cleanly instead.
   */
  subtitleNumberOfLines?: number;
  /**
   * Node rendered in the subtitle's place while the value that fills it loads.
   * The row's subtitle is one line of `text-xs`, so a placeholder of that
   * height keeps the row's settled size: the rows below never move, and the
   * card does not print loading copy. The caller builds it, because the width
   * that stands in for the settled text is the caller's.
   */
  subtitlePlaceholder?: ReactNode;
  /**
   * Semantic tone override (good / warn / danger). When omitted the row uses
   * the shared neutral tile, so every row in a settings list carries the same
   * accent instead of a hue hashed from its title.
   */
  tone?: ToneKey;
  /**
   * Curated destination hue (see `RowHue`). A row identifies a destination, so
   * its colour is chosen once in the table and passed explicitly here; it is
   * never derived from the title. A semantic tone outranks it.
   */
  hue?: RowHue;
  onPress?: () => void;
  disabled?: boolean;
  /**
   * Full accessible name of the pressable row. Set it when the row's state or
   * its action is not readable from the text a reader can already hear:
   * `accessibilityHint` cannot carry that on Android, where React Native maps
   * it to the node's tooltip and never to its content description, so the name
   * is the only place TalkBack reads. Omit it and the name stays the row's
   * visible text.
   */
  accessibilityLabel?: string;
  trailing?: ReactNode;
  /** Suppress bottom divider on the last row of a group. */
  last?: boolean;
  className?: string;
};

/** Neutral (or `tone`-tinted) icon tile + title + subtitle + trailing chevron row. */
export function ConfigureRow({
  icon: Icon,
  title,
  subtitle,
  subtitleNumberOfLines,
  subtitlePlaceholder,
  tone,
  hue,
  onPress,
  disabled,
  accessibilityLabel,
  trailing,
  last,
  className,
}: Readonly<ConfigureRowProps>) {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const fontScale = useLiveFontScale();
  // A narrow window squeezes the flexible text block between the fixed icon
  // tile and the chevron exactly as a large font scale does, until a whole word
  // no longer fits and Android breaks it mid-word ("Gene ral", 160 dp, e1,
  // 2026-09-21). Both cases get the stacked presentation, which hands the
  // title the row's full width.
  const stack = fontScale >= CONFIGURE_ROW_STACK_FONT_SCALE || isNarrowLayout(width);
  // A semantic tone outranks the curated destination hue, and a row carrying
  // neither keeps the shared neutral tile. A settings list is not a list of
  // agents: hashing each title into the agent hue ramp gave one list (Language
  // / Trusted hosts / Device sessions) three different accents, and a title
  // never picks a hue here.
  let tint: Tint = NEUTRAL_TINT;
  if (tone) {
    tint = toneColor(tone);
  } else if (hue) {
    tint = rowTint(hue);
  }
  // Inert rows (no onPress) and disabled rows are not tappable — hide the
  // chevron so they don't look tappable, and never render pressed feedback.
  const showChevron = Boolean(onPress) && !disabled;
  const trailingNode =
    trailing ??
    (showChevron ? <DirectionalChevronRight size={14} color={colors.mutedForeground} /> : null);

  // A disabled row dims by token, once, and never by row opacity: halving the
  // row lands the already-muted subtitle at 2.15:1 on the dark `bg-secondary`
  // card and 1.95:1 on the light one, so the last line of an unavailable row
  // out of reach of a user who cannot act on it. The muted ink keeps 4.53:1
  // dark and 4.62:1 light, and the icon leaves the tint's hue for the same
  // ink (4.05:1 on the tile). The tile's own low-alpha fill and border stay,
  // and the chevron, the pressed feedback and the row Pressable's
  // `accessibilityState` are what still say "unavailable". The inner layout
  // View owns no role, so it declares no interactive state of its own: a
  // state on it would announce disablement from a node a reader never reaches.
  const iconTint: Tint = disabled ? { ...tint, hueThemeKey: 'mutedForeground' } : tint;

  const iconTile = <IconTile icon={Icon} tint={iconTint} />;

  let subtitleNode: ReactNode = subtitlePlaceholder ?? null;
  if (subtitle) {
    subtitleNode = (
      <Text numberOfLines={subtitleNumberOfLines} className="mt-0.5 text-xs text-muted-foreground">
        {subtitle}
      </Text>
    );
  }

  const textBlock = (
    <View className={cn('min-w-0', stack ? 'w-full' : 'flex-1')}>
      <Text
        className={cn(
          'text-sm font-medium',
          disabled ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {title}
      </Text>
      {subtitleNode}
    </View>
  );

  const inner = (
    <View
      className={cn(
        stack ? 'gap-2 py-3' : 'flex-row items-center gap-3 py-3',
        !last && 'border-b-[0.5px] border-hair-soft',
        className
      )}
    >
      {stack ? (
        <>
          <View className="w-full flex-row items-center justify-between gap-3">
            {iconTile}
            {trailingNode ? <View className="shrink-0">{trailingNode}</View> : null}
          </View>
          {textBlock}
        </>
      ) : (
        <>
          {iconTile}
          {textBlock}
          {trailingNode}
        </>
      )}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: Boolean(disabled) }}
        className={cn(!disabled && 'active:opacity-70')}
      >
        {inner}
      </Pressable>
    );
  }
  return inner;
}
