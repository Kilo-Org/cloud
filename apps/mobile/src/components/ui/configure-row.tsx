import { ChevronRight, type LucideIcon } from 'lucide-react-native';
import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { agentColor, type Tint, toneColor, type ToneKey } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

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
  const tint: Tint = tone ? toneColor(tone) : agentColor(title);
  const iconColor = colors[tint.hueThemeKey];
  // Inert rows (no onPress) and disabled rows are not tappable — hide the
  // chevron so they don't look tappable, and never render pressed feedback.
  const showChevron = Boolean(onPress) && !disabled;

  const inner = (
    <View
      accessibilityState={{ disabled: Boolean(disabled) }}
      className={cn(
        'flex-row items-center gap-3 py-3',
        !last && 'border-b-[0.5px] border-hair-soft',
        disabled && 'opacity-50',
        className
      )}
    >
      <View
        className={cn(
          'h-[30px] w-[30px] items-center justify-center rounded-lg border',
          tint.tileBgClass,
          tint.tileBorderClass
        )}
      >
        <Icon size={16} color={iconColor} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground">{title}</Text>
        {subtitle ? <Text className="mt-0.5 text-xs text-muted-foreground">{subtitle}</Text> : null}
      </View>
      {trailing ?? (showChevron ? <ChevronRight size={14} color={colors.mutedForeground} /> : null)}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityState={{ disabled: Boolean(disabled) }}
        className={cn(!disabled && 'active:opacity-70')}
      >
        {inner}
      </Pressable>
    );
  }
  return inner;
}
