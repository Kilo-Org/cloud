import { AlertTriangle } from '@/components/ui/icons';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Durable failure card for a Security Agent command that failed before the
 * server accepted a command id (no command observer will reconcile it). Shows
 * the stored `lastError`; a retryable failure offers Retry and Discard, a
 * non-retryable one keeps the card but hides Retry (the draft stays so the
 * state survives restart).
 */
type SecurityCommandRetryCardProps = {
  lastError: string;
  retryable: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
};

export function SecurityCommandRetryCard({
  lastError,
  retryable,
  onRetry,
  onDiscard,
}: Readonly<SecurityCommandRetryCardProps>) {
  const colors = useThemeColors();
  return (
    <View className="gap-3 rounded-lg border border-destructive bg-red-50 p-3 dark:bg-red-950">
      <View className="flex-row items-start gap-2">
        <AlertTriangle size={16} color={colors.destructive} className="mt-0.5" />
        <Text className="flex-1 text-sm text-destructive">{lastError}</Text>
      </View>
      {retryable ? (
        <View className="flex-row gap-2">
          <Button size="sm" className="flex-1" onPress={onRetry}>
            <Text>Retry</Text>
          </Button>
          <Button size="sm" variant="ghost" onPress={onDiscard}>
            <Text>Discard</Text>
          </Button>
        </View>
      ) : null}
    </View>
  );
}
