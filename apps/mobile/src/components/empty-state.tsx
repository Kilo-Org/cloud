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
      <View className="h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card">
        <Icon size={24} color={colors.mutedForeground} strokeWidth={1.5} />
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
