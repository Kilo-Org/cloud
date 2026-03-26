import { type LucideIcon } from 'lucide-react-native';
import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
  action?: ReactNode;
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  className,
  action,
}: Readonly<EmptyStateProps>) {
  const colors = useThemeColors();

  return (
    <View className={cn('items-center justify-center gap-4 px-6', className)}>
      <View className="items-center justify-center rounded-full bg-muted p-4">
        <Icon size={32} color={colors.mutedForeground} />
      </View>
      <View className="items-center gap-1">
        <Text variant="large">{title}</Text>
        <Text variant="muted" className="text-center">
          {description}
        </Text>
      </View>
      {action}
    </View>
  );
}
