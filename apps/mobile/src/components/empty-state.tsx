import { type LucideIcon } from 'lucide-react-native';
import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const DEFAULT_ICON_CONTAINER_CLASS = 'h-14 w-14 rounded-2xl border border-border bg-card';

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
  action?: ReactNode;
  placement?: 'center' | 'top';
  /** Overrides the icon bubble's container classes (size/shape/background). Defaults to the card-style bubble. */
  iconContainerClassName?: string;
  iconSize?: number;
  iconStrokeWidth?: number;
  /** Set to 'header' when the title acts as the screen's heading (QueryError does). */
  titleAccessibilityRole?: 'header';
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  className,
  action,
  placement = 'center',
  iconContainerClassName = DEFAULT_ICON_CONTAINER_CLASS,
  iconSize = 24,
  iconStrokeWidth = 1.5,
  titleAccessibilityRole,
}: Readonly<EmptyStateProps>) {
  const colors = useThemeColors();

  return (
    <View
      className={cn(
        'gap-4 px-6',
        placement === 'center' ? 'flex-1 items-center justify-center' : 'items-center pt-16',
        className
      )}
    >
      <View className={cn('items-center justify-center', iconContainerClassName)}>
        <Icon size={iconSize} color={colors.mutedForeground} strokeWidth={iconStrokeWidth} />
      </View>
      <View className="items-center gap-1">
        <Text variant="large" accessibilityRole={titleAccessibilityRole}>
          {title}
        </Text>
        <Text variant="muted" className="text-center">
          {description}
        </Text>
      </View>
      {action}
    </View>
  );
}
