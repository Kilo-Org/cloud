import { type LucideIcon } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { type ReactNode } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { agentColor, type Tint, toneColor, type ToneKey } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/**
 * At/above this Dynamic Type scale, ConfigureRow stacks the icon above the
 * title block so long labels never clip against the chevron in a side row.
 * Matches the tab-label wrap threshold used elsewhere in the shell.
 */
export const CONFIGURE_ROW_STACK_FONT_SCALE = 1.8;

type ConfigureRowProps = {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /**
   * Semantic tone override (good / warn / danger). When omitted the tile
   * tint is hashed from `title` so consistent titles stay on the same hue
   * without any explicit mapping.
   */
  tone?: ToneKey;
  onPress?: () => void;
  disabled?: boolean;
  trailing?: ReactNode;
  /** Suppress bottom divider on the last row of a group. */
  last?: boolean;
  className?: string;
};

/** Tinted icon tile + title + subtitle + trailing chevron row. */
export function ConfigureRow({
  icon: Icon,
  title,
  subtitle,
  tone,
  onPress,
  disabled,
  trailing,
  last,
  className,
}: Readonly<ConfigureRowProps>) {
  const colors = useThemeColors();
  const { fontScale } = useWindowDimensions();
  const stack = fontScale >= CONFIGURE_ROW_STACK_FONT_SCALE;
  const tint: Tint = tone ? toneColor(tone) : agentColor(title);
  const iconColor = colors[tint.hueThemeKey];
  // Inert rows (no onPress) and disabled rows are not tappable — hide the
  // chevron so they don't look tappable, and never render pressed feedback.
  const showChevron = Boolean(onPress) && !disabled;
  const trailingNode =
    trailing ?? (showChevron ? <DirectionalChevronRight size={14} color={colors.mutedForeground} /> : null);

  const iconTile = (
    <View
      className={cn(
        'h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border',
        tint.tileBgClass,
        tint.tileBorderClass
      )}
    >
      <Icon size={16} color={iconColor} />
    </View>
  );

  const textBlock = (
    <View className={cn('min-w-0', stack ? 'w-full' : 'flex-1')}>
      <Text className="text-sm font-medium text-foreground">{title}</Text>
      {subtitle ? <Text className="mt-0.5 text-xs text-muted-foreground">{subtitle}</Text> : null}
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
