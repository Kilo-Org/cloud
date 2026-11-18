import { type ReactNode } from 'react';
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
 *
 * `tint` is the single explicit entry point for a tile's colour: a caller
 * resolves it from the shared palette (`rowTint` / `toneColor` / `NEUTRAL_TINT`)
 * and passes it in. No caller may derive a tint from a label, title,
 * translation or hash of any string — that made a row's colour change with the
 * language.
 *
 * `content` replaces the stroked icon inside the same frame, for a row whose
 * leading cell changes while it works (a busy spinner). The frame stays 30 dp
 * either way, so a row never moves its own title.
 */
export function IconTile({
  icon: Icon,
  tint,
  className,
  content,
}: Readonly<{
  icon?: LucideIcon;
  tint: Tint;
  className?: string;
  /** Node rendered in place of the icon, inside the same frame. */
  content?: ReactNode;
}>) {
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
      {content ?? (Icon === undefined ? null : <Icon size={16} color={colors[tint.hueThemeKey]} />)}
    </View>
  );
}
