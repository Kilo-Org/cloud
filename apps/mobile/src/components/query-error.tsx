import {
  AlertCircle,
  Lock,
  type LucideIcon,
  SearchX,
  ServerCrash,
  WifiOff,
} from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type QueryErrorVariant = 'neutral' | 'offline' | 'permission' | 'not-found' | 'server';

const VARIANT_META: Record<
  QueryErrorVariant,
  { icon: LucideIcon; title: string; description: string }
> = {
  neutral: {
    icon: AlertCircle,
    title: 'Something went wrong',
    description: 'Please try again.',
  },
  offline: {
    icon: WifiOff,
    title: 'Failed to load',
    description: 'Something went wrong',
  },
  permission: {
    icon: Lock,
    title: 'Access denied',
    description: "You don't have permission to view this.",
  },
  'not-found': {
    icon: SearchX,
    title: 'Not found',
    description: 'This item may have been removed or is no longer available.',
  },
  server: {
    icon: ServerCrash,
    title: 'Could not load',
    description: 'Something went wrong on our end. Please try again.',
  },
};

type QueryErrorProps = {
  variant?: QueryErrorVariant;
  title?: string;
  /** Same as `description`, kept for existing call sites. New call sites should use `description` instead. */
  message?: string;
  description?: string;
  onRetry?: () => void;
  isRetrying?: boolean;
  className?: string;
  placement?: 'center' | 'top';
};

export function QueryError({
  variant = 'offline',
  title,
  message,
  description,
  onRetry,
  isRetrying = false,
  className,
  placement = 'center',
}: Readonly<QueryErrorProps>) {
  const colors = useThemeColors();
  const meta = VARIANT_META[variant];
  const Icon = meta.icon;

  return (
    <View
      className={cn(
        'gap-4 px-6',
        placement === 'center' ? 'flex-1 items-center justify-center' : 'items-center pt-16',
        className
      )}
    >
      <View className="items-center justify-center rounded-full bg-muted p-4">
        <Icon size={32} color={colors.mutedForeground} />
      </View>
      <View className="items-center gap-1">
        <Text variant="large" accessibilityRole="header">
          {title ?? meta.title}
        </Text>
        <Text variant="muted" className="text-center">
          {description ?? message ?? meta.description}
        </Text>
      </View>
      {onRetry && (
        <Button variant="outline" onPress={onRetry} loading={isRetrying} accessibilityLabel="Retry">
          <Text>Retry</Text>
        </Button>
      )}
    </View>
  );
}
