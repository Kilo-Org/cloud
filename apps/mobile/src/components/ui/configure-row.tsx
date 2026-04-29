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
  trailing,
  last,
  className,
}: Readonly<ConfigureRowProps>) {
  const colors = useThemeColors();
  const tint: Tint = tone ? toneColor(tone) : agentColor(title);
  const iconColor = colors[tint.hueThemeKey];

  const inner = (
    <View
      className={cn(
        'flex-row items-center gap-3 py-3',
        !last && 'border-b-[0.5px] border-hair-soft',
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
        <Text className="text-[14px] font-medium text-foreground">{title}</Text>
        {subtitle ? (
          <Text className="mt-0.5 text-[11.5px] text-muted-foreground">{subtitle}</Text>
        ) : null}
      </View>
      {trailing ?? <ChevronRight size={14} color={colors.mutedForeground} />}
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} className="active:opacity-70">
        {inner}
      </Pressable>
    );
  }
  return inner;
}
