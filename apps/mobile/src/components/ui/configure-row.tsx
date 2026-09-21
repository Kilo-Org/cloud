import { type LucideIcon } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { IconTile } from '@/components/ui/icon-tile';
import { type ReactNode } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type Tint, toneColor, type ToneKey } from '@/lib/agent-color';
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

/**
 * Every row without a semantic tone renders this one neutral tile. A settings
 * list is not a list of agents: hashing each title into the agent hue ramp
 * gave a single list (Language / Trusted hosts / Device sessions) three
 * different accent tints. The neutral tile matches the sibling settings rows
 * (PreferenceRow, notifications CategoryRow), which use the un-tinted
 * secondary-foreground icon.
 *
 * It is shaped as a `Tint` so the shared `IconTile` renders it: the tile
 * classes are the same neutral pair the row used inline, and the icon keeps
 * the secondary-foreground stroke.
 */
const NEUTRAL_TINT = {
  hueClass: 'bg-hair-soft',
  hueTextClass: 'text-secondary-foreground',
  hueBorderClass: 'border-border',
  tileBgClass: 'bg-hair-soft',
  tileBorderClass: 'border-border',
  hueThemeKey: 'secondaryForeground',
} as const satisfies Tint;

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
   * Semantic tone override (good / warn / danger). When omitted the row uses
   * the shared neutral tile, so every row in a settings list carries the same
   * accent instead of a hue hashed from its title.
   */
  tone?: ToneKey;
  onPress?: () => void;
  disabled?: boolean;
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
  tone,
  onPress,
  disabled,
  trailing,
  last,
  className,
}: Readonly<ConfigureRowProps>) {
  const colors = useThemeColors();
  const { fontScale, width } = useWindowDimensions();
  // A narrow window squeezes the flexible text block between the fixed icon
  // tile and the chevron exactly as a large font scale does, until a whole word
  // no longer fits and Android breaks it mid-word ("Gene ral", 160 dp, e1,
  // 2026-09-21). Both cases get the stacked presentation, which hands the
  // title the row's full width.
  const stack = fontScale >= CONFIGURE_ROW_STACK_FONT_SCALE || isNarrowLayout(width);
  // A semantic tone overrides the shared neutral tile; a title never hashes
  // into an agent hue here.
  const tint: Tint = tone ? toneColor(tone) : NEUTRAL_TINT;
  // Inert rows (no onPress) and disabled rows are not tappable — hide the
  // chevron so they don't look tappable, and never render pressed feedback.
  const showChevron = Boolean(onPress) && !disabled;
  const trailingNode =
    trailing ??
    (showChevron ? <DirectionalChevronRight size={14} color={colors.mutedForeground} /> : null);

  const iconTile = <IconTile icon={Icon} tint={tint} />;

  const textBlock = (
    <View className={cn('min-w-0', stack ? 'w-full' : 'flex-1')}>
      <Text className="text-sm font-medium text-foreground">{title}</Text>
      {subtitle ? (
        <Text
          numberOfLines={subtitleNumberOfLines}
          className="mt-0.5 text-xs text-muted-foreground"
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );

  const inner = (
    <View
      accessibilityState={{ disabled: Boolean(disabled) }}
      className={cn(
        stack ? 'gap-2 py-3' : 'flex-row items-center gap-3 py-3',
        !last && 'border-b-[0.5px] border-hair-soft',
        disabled && 'opacity-50',
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
        accessibilityState={{ disabled: Boolean(disabled) }}
        className={cn(!disabled && 'active:opacity-70')}
      >
        {inner}
      </Pressable>
    );
  }
  return inner;
}
