import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * The retained failure of an idle chat, in fixed copy.
 *
 * The Retry is here only when no question waits for an answer: an open that
 * failed, or a tool move that failed after the answer landed. An unanswered
 * question carries its own Retry on the message, so this row then states why
 * and offers no second button.
 */
export function ChatFailureRow({
  failureKey,
  onRetry,
}: Readonly<{ failureKey: string; onRetry?: () => void }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 px-4 py-2">
      <AccessibleStatus message={t(failureKey)} tone="error" className="flex-1 text-sm" />
      {onRetry ? (
        <Button variant="outline" size="sm" onPress={onRetry}>
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
