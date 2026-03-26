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
};

export function QueryError({
  message = 'Something went wrong',
  onRetry,
  className,
}: Readonly<QueryErrorProps>) {
  const colors = useThemeColors();

  return (
    <View className={cn('items-center justify-center gap-4 px-6', className)}>
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
