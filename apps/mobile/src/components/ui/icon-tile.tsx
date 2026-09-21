import { View } from 'react-native';

import { type LucideIcon } from '@/components/ui/icons';
import { type Tint } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/**
 * The one tinted icon treatment: a 30×30 rounded-square tile behind a 16px
 * icon. `tint` carries the tile background/border classes and the hue the icon
 * is stroked with; class names stay string literals on `tint` so NativeWind's
 * static scanner compiles them.
 */
export function IconTile({
  icon: Icon,
  tint,
  className,
}: Readonly<{ icon: LucideIcon; tint: Tint; className?: string }>) {
  const colors = useThemeColors();
  return (
    <View
      className={cn(
        'h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border',
        tint.tileBgClass,
        tint.tileBorderClass,
        className
      )}
    >
      <Icon size={16} color={colors[tint.hueThemeKey]} />
    </View>
  );
}
