import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * The retained failure of an idle chat, in fixed copy.
 *
 * One action answers what failed: Retry when no question waits for an answer,
 * and Add credits when the account could not pay for the send. An unanswered
 * question carries its own Retry on the message, so this row then states why
 * and offers the action the message cannot: settling the bill.
 */
export function ChatFailureRow({
  failureKey,
  onRetry,
  onAddCredits,
}: Readonly<{ failureKey: string; onRetry?: () => void; onAddCredits?: () => void }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 px-4 py-2">
      <AccessibleStatus message={t(failureKey)} tone="error" className="flex-1 text-sm" />
      {onAddCredits ? (
        <Button variant="outline" size="sm" onPress={onAddCredits}>
          <Text>{t('addCredits.cta')}</Text>
        </Button>
      ) : null}
      {onRetry ? (
        <Button variant="outline" size="sm" onPress={onRetry}>
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
