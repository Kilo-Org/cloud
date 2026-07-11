import { WifiOff } from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type QueryErrorProps = {
  message?: string;
  onRetry?: () => void;
  className?: string;
  placement?: 'center' | 'top';
};

export function QueryError({
  message = 'Something went wrong',
  onRetry,
  className,
  placement = 'center',
}: Readonly<QueryErrorProps>) {
  const colors = useThemeColors();

  return (
    <View
      className={cn(
        'gap-4 px-6',
        placement === 'center' ? 'flex-1 items-center justify-center' : 'items-center pt-16',
        className
      )}
    >
      <View className="items-center justify-center rounded-full bg-muted p-4">
        <WifiOff size={32} color={colors.mutedForeground} />
      </View>
      <View className="items-center gap-1">
        <Text variant="large">Failed to load</Text>
        <Text variant="muted" className="text-center">
          {message}
        </Text>
      </View>
      {onRetry && (
        <Button variant="outline" onPress={onRetry} accessibilityLabel="Retry">
          <Text>Retry</Text>
        </Button>
      )}
    </View>
  );
}
